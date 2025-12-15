import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import Airtable from 'airtable';
import fetch from 'node-fetch';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  PermissionsBitField
} from 'discord.js';

/* ---------------- ENV CONFIG ---------------- */

const {
  DISCORD_TOKEN,
  DISCORD_DEALS_CHANNEL_ID,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_SELLER_OFFERS_TABLE,
  AIRTABLE_SELLERS_TABLE,
  AIRTABLE_ORDERS_TABLE,
  AIRTABLE_PARTNERS_TABLE,
  PAYOUT_CATEGORY_ID,
  PROCESS_DEAL_WEBHOOK_URL,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_DEALS_CHANNEL_ID || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('❌ Missing required environment variables.');
  process.exit(1);
}

const dealsChannelIds = String(DISCORD_DEALS_CHANNEL_ID)
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

// Airtable view URL for “See All WTB’s” button
const WTB_URL =
  'https://airtable.com/invite/l?inviteId=invwmhpKlD6KmJe6n&inviteToken=a14697b7435e64f6ee429f8b59fbb07bc0474aaf66c8ff59068aa5ceb2842253&utm_medium=email&utm_source=product_team&utm_content=transactional-alerts';

const INVITE_URL = 'https://discord.gg/Fw3gTmGt';

/* ---------------- Airtable ---------------- */

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const sellerOffersTableName = AIRTABLE_SELLER_OFFERS_TABLE || 'Seller Offers';
const sellersTableName = AIRTABLE_SELLERS_TABLE || 'Sellers Database';
const ordersTableName = AIRTABLE_ORDERS_TABLE || 'Unfulfilled Orders Log';
const partnersTableName = AIRTABLE_PARTNERS_TABLE || 'Partnerships';

const ORDER_FIELD_SELLER_MSG_IDS = 'Seller Offer Message ID';
const ORDER_FIELD_BUTTONS_DISABLED = 'Seller Offer Buttons Disabled';
const ORDER_FIELD_CURRENT_LOWEST_OFFER = 'Current Lowest Offer';

const PARTNER_FIELD_WEBHOOK_URL = 'WTB Webhook URL';
const PARTNER_FIELD_ACTIVE = 'Active?';
const PARTNER_FIELD_WTB_MESSAGES = 'Partner WTB Messages';

/* ---------------- Utilities ---------------- */

const MIN_UNDERCUT_STEP = 2.5;

function normalizeVatType(raw) {
  if (!raw) return null;
  if (raw === 'Margin') return 'Margin';
  if (raw === 'VAT0') return 'VAT0';
  if (raw === 'VAT21') return 'VAT21';
  return null;
}

function parseNumeric(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = parseFloat(value.replace(',', '.').replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Normalize an offer for comparison:
 * - VAT0 → *1.21
 * - Margin/VAT21 → as-is (treated as gross)
 */
function getNormalized(price, vatType) {
  if (!Number.isFinite(price)) return null;
  if (vatType === 'VAT0') return price * 1.21;
  return price;
}

/**
 * Format lowest offer incl. VAT conversions
 * (used in the undercut error messaging).
 */
function formatLowestForDisplay(lowest) {
  if (!lowest || typeof lowest.raw !== 'number') return 'N/A';

  let displayType = lowest.vatType;
  if (lowest.vatType === 'VAT21') displayType = 'Margin';

  const baseStr = `€${lowest.raw.toFixed(2)}${displayType ? ` (${displayType})` : ''}`;

  if (lowest.vatType === 'VAT21') {
    const asVat0 = lowest.raw / 1.21;
    return `${baseStr} / €${asVat0.toFixed(2)} (VAT0)`;
  }

  if (lowest.vatType === 'VAT0') {
    const asMargin = lowest.raw * 1.21;
    return `${baseStr} / €${asMargin.toFixed(2)} (Margin)`;
  }

  return baseStr;
}

// Safe DM helper with "Retry Offer" button
async function safeDMWithRetry(user, content, retryCustomId) {
  try {
    if (!retryCustomId) {
      await user.send({ content });
      return;
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(retryCustomId).setLabel('Retry Offer').setStyle(ButtonStyle.Primary)
    );

    await user.send({ content, components: [row] });
  } catch (e) {
    console.warn('DM failed:', e?.message || e);
  }
}

/* ---------------- Discord ---------------- */

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, (c) => {
  console.log(`🤖 WTB Seller Offer Bot logged in as ${c.user.tag}`);
});

client.login(DISCORD_TOKEN);

/* ---------------- Lowest offer calculation ---------------- */

async function getCurrentLowest(orderId) {
  if (!orderId) return null;

  const offers = await base(sellerOffersTableName).select().all();

  let best = null;

  for (const rec of offers) {
    const links = rec.get('Linked Orders');
    if (!Array.isArray(links)) continue;

    const matches = links.some((l) => (typeof l === 'string' ? l === orderId : l?.id === orderId));
    if (!matches) continue;

    const price = parseNumeric(rec.get('Seller Offer'));
    const vatRaw = rec.get('Offer VAT Type');
    const vat = typeof vatRaw === 'string' ? vatRaw : vatRaw?.name;
    const vatNorm = normalizeVatType(vat);
    if (!price) continue;

    const normalized = getNormalized(price, vatNorm);
    if (!Number.isFinite(normalized)) continue;

    if (!best || normalized < best.normalized) {
      best = { normalized, raw: price, vatType: vatNorm };
    }
  }

  if (best) return best;

  // Fallback: if there are no offers yet, use order's Maximum Buying Price as baseline
  const order = await base(ordersTableName).find(orderId).catch(() => null);
  if (!order) return null;

  const maxPrice = parseNumeric(order.get('Maximum Buying Price'));
  if (!Number.isFinite(maxPrice)) return null;

  return { normalized: maxPrice, raw: maxPrice, vatType: 'Margin' };
}

/* ---------------- Disable messages (your server) ---------------- */

async function disableSellerOfferMessages(orderId) {
  const order = await base(ordersTableName).find(orderId).catch(() => null);
  if (!order) return;

  const rawIds = order.get(ORDER_FIELD_SELLER_MSG_IDS);
  if (rawIds) {
    const msgIds = String(rawIds).split(',').map((x) => x.trim()).filter(Boolean);

    for (const channelId of dealsChannelIds) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      for (const id of msgIds) {
        const msg = await channel.messages.fetch(id).catch(() => null);
        if (!msg) continue;

        const disabled = msg.components.map((row) =>
          new ActionRowBuilder().addComponents(
            ...row.components.map((btn) => ButtonBuilder.from(btn).setDisabled(true))
          )
        );

        await msg.edit({ components: disabled }).catch(() => null);
      }
    }
  }

  await base(ordersTableName).update(orderId, { [ORDER_FIELD_BUTTONS_DISABLED]: true }).catch(() => null);
}

/* ---------------- Update "Current Lowest Offer" in your server embeds ---------------- */

async function updateLowestOfferDisplays(orderId) {
  if (!orderId) return;

  const order = await base(ordersTableName).find(orderId).catch(() => null);
  if (!order) return;

  const currentLowestRaw = order.get(ORDER_FIELD_CURRENT_LOWEST_OFFER);
  const currentLowestDisplay = currentLowestRaw ? String(currentLowestRaw) : 'No offers yet';

  const rawInternalIds = order.get(ORDER_FIELD_SELLER_MSG_IDS);
  if (!rawInternalIds) return;

  const msgIds = String(rawInternalIds).split(',').map((x) => x.trim()).filter(Boolean);

  for (const channelId of dealsChannelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) continue;

    for (const id of msgIds) {
      const msg = await channel.messages.fetch(id).catch(() => null);
      if (!msg || !msg.embeds?.length) continue;

      const oldEmbed = msg.embeds[0];
      const newEmbed = EmbedBuilder.from(oldEmbed);

      const existingFields = Array.isArray(newEmbed.data?.fields) ? newEmbed.data.fields : [];
      const filteredFields = existingFields.filter((f) => f.name !== 'Current Lowest Offer');

      filteredFields.push({
        name: 'Current Lowest Offer',
        value: `${currentLowestDisplay}\n\nClick below to submit your offer.`,
        inline: false
      });

      newEmbed.setFields(filteredFields);

      await msg.edit({ embeds: [newEmbed] }).catch(() => null);
    }
  }
}

/* ---------------- Helper: get active partners ---------------- */

async function getActivePartners() {
  const records = await base(partnersTableName)
    .select({
      filterByFormula: `AND({${PARTNER_FIELD_ACTIVE}}, {${PARTNER_FIELD_WEBHOOK_URL}} != '')`
    })
    .all();

  return records.map((rec) => ({
    id: rec.id,
    name: rec.get('Name'),
    webhookUrl: rec.get(PARTNER_FIELD_WEBHOOK_URL),
    messagesLog: rec.get(PARTNER_FIELD_WTB_MESSAGES) || ''
  }));
}

/* ---------------- Express API ---------------- */

const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.send('WTB Seller Offers Bot OK'));

/* ---------------- POST /partner-offer-deal ---------------- */
/* Internal WTB in your own server */

async function sendOfferDeal(req, res) {
  try {
    const { productName, sku, size, brand, imageUrl, recordId } = req.body || {};

    // Read current lowest from the order (for initial embed)
    let currentLowestDisplay = 'No offers yet';
    if (recordId) {
      const order = await base(ordersTableName).find(recordId).catch(() => null);
      if (order) {
        const rawLowest = order.get(ORDER_FIELD_CURRENT_LOWEST_OFFER);
        if (rawLowest) currentLowestDisplay = String(rawLowest);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('🔥 NEW WTB DEAL 🔥')
      .setDescription(`**${productName}**\n${sku}\n${size}\n${brand}`)
      .setColor(0xf1c40f)
      .addFields({
        name: 'Current Lowest Offer',
        value: `${currentLowestDisplay}\n\nClick below to submit your offer.`,
        inline: false
      });

    if (imageUrl) embed.setImage(imageUrl);

    const messageIds = [];
    const messageUrls = [];

    for (const channelId of dealsChannelIds) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('seller_offer').setLabel('Offer').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setLabel("See All WTB's").setStyle(ButtonStyle.Link).setURL(WTB_URL)
      );

      const msg = await channel.send({ embeds: [embed], components: [row] });

      messageIds.push(msg.id);
      messageUrls.push(msg.url);
    }

    if (recordId) {
      const updateFields = {
        [ORDER_FIELD_SELLER_MSG_IDS]: messageIds.join(','),
        [ORDER_FIELD_BUTTONS_DISABLED]: false
      };

      if (messageUrls.length > 0) updateFields['Offer Message URL'] = messageUrls[0];

      await base(ordersTableName).update(recordId, updateFields);
    }

    return res.json({ ok: true, messageIds, messageUrls });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

app.post('/partner-offer-deal', sendOfferDeal);
app.post('/partner-deal', sendOfferDeal);

/* ---------------- POST /partner-wtb ---------------- */
/* Sends WTB embed into partner servers via webhooks */

app.post('/partner-wtb', async (req, res) => {
  try {
    const { productName, sku, size, brand, imageUrl, recordId } = req.body || {};

    if (!recordId) return res.status(400).json({ error: 'recordId is required' });

    const order = await base(ordersTableName).find(recordId).catch(() => null);
    if (!order) return res.status(404).json({ error: 'Order not found in Airtable' });

    const offerMessageUrl = order.get('Offer Message URL');
    if (!offerMessageUrl) return res.status(400).json({ error: 'Offer Message URL is empty for this order' });

    const currentLowestRaw = order.get(ORDER_FIELD_CURRENT_LOWEST_OFFER);
    const currentLowestDisplay = currentLowestRaw ? String(currentLowestRaw) : 'No offers yet';

    const partners = await getActivePartners();
    if (!partners.length) return res.json({ ok: true, message: 'No active partners found' });

    const sentByPartner = [];

    for (const partner of partners) {
      const payload = {
        embeds: [
          {
            title: '🔥 NEW WTB DEAL 🔥',
            description: `**${productName}**\n${sku}\n${size}\n${brand}`,
            color: 0xf1c40f,
            fields: [
              { name: 'Current Lowest Offer', value: `${currentLowestDisplay}`, inline: false },
              {
                name: 'How to Offer',
                value:
                  `The **Offer** button links directly to the deal in our server.\n` +
                  `Not joined yet? Join first: [JOIN HERE](${INVITE_URL})`,
                inline: false
              }
            ],
            ...(imageUrl ? { image: { url: imageUrl } } : {})
          }
        ],
        components: [
          {
            type: 1,
            components: [
              { type: 2, style: 5, label: 'Offer', url: offerMessageUrl },
              { type: 2, style: 5, label: "See All WTB's", url: WTB_URL }
            ]
          }
        ]
      };

      const resp = await fetch(`${partner.webhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch((err) => {
        console.error('Error sending partner webhook:', err);
        return null;
      });

      if (!resp || !resp.ok) {
        console.warn(`Failed sending WTB to partner ${partner.name}`);
        continue;
      }

      const data = await resp.json();
      const messageId = data.id;

      if (messageId) {
        sentByPartner.push({ partnerId: partner.id, messageId });

        const prevLog = partner.messagesLog || '';
        const newLine = `${recordId}:${messageId}`;
        const updatedLog = prevLog ? `${prevLog}\n${newLine}` : newLine;

        await base(partnersTableName).update(partner.id, { [PARTNER_FIELD_WTB_MESSAGES]: updatedLog }).catch(() => null);
      }
    }

    return res.json({ ok: true, sent: sentByPartner });
  } catch (err) {
    console.error('Error in /partner-wtb:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- POST /seller-offer/disable ---------------- */

app.post('/seller-offer/disable', async (req, res) => {
  const { recordId } = req.body || {};
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });

  await disableSellerOfferMessages(recordId);
  return res.json({ ok: true });
});

/* ---------------- POST /payout-channel ---------------- */

app.post('/payout-channel', async (req, res) => {
  try {
    const { orderId, productName, sku, size, brand, payout, sellerCode, imageUrl, discordUserId, vatType } =
      req.body || {};

    const category = await client.channels.fetch(PAYOUT_CATEGORY_ID).catch(() => null);
    if (!category || !category.guild) return res.status(500).json({ error: 'Invalid payout category' });

    const guild = category.guild;

    await guild.members.fetch(discordUserId).catch(() => null);

    const channel = await guild.channels.create({
      name: `wtb-${String(orderId || '').toLowerCase()}`,
      parent: category.id,
      permissionOverwrites: [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        {
          id: discordUserId,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory
          ]
        }
      ]
    });

    const payoutNum = Number(payout);

    const embed = new EmbedBuilder()
      .setTitle('✅ Offer Accepted')
      .setDescription(
        `**Order:** ${orderId}\n` +
          `**Product:** ${productName}\n` +
          `**SKU:** ${sku}\n` +
          `**Size:** ${size}\n` +
          `**Brand:** ${brand}\n` +
          `**Payout:** €${Number.isFinite(payoutNum) ? payoutNum.toFixed(2) : '0.00'}\n` +
          `**Seller:** ${sellerCode}\n` +
          (vatType ? `**VAT Type:** ${vatType}\n` : '')
      )
      .setColor(0xf1c40f);

    if (imageUrl) embed.setImage(imageUrl);

    const customId = `process_payout:${orderId}:${sellerCode}:${discordUserId}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId).setLabel('Process Deal').setStyle(ButtonStyle.Primary)
    );

    await channel.send({ content: `<@${discordUserId}>`, embeds: [embed], components: [row] });

    return res.json({ ok: true, channelId: channel.id });
  } catch (err) {
    console.error('Error in /payout-channel:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- POST /sync-lowest ---------------- */

app.post('/sync-lowest', async (req, res) => {
  try {
    const { orderId } = req.body || {};
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    await updateLowestOfferDisplays(orderId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error in /sync-lowest:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- Discord Interaction Logic ---------------- */

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    /* ---- PROCESS DEAL BUTTON ---- */
    if (interaction.isButton() && interaction.customId.startsWith('process_payout:')) {
      const [, orderId, sellerCode, discordUserId] = interaction.customId.split(':');

      const embed = interaction.message.embeds?.[0];
      if (!embed || !embed.description) {
        return interaction.reply({ content: '❌ Missing deal details on this message.', ephemeral: true });
      }

      const lines = embed.description.split('\n');
      const get = (label) => {
        const line = lines.find((l) => l.startsWith(label));
        return line ? line.replace(label, '').trim() : null;
      };

      const payoutRaw = get('**Payout:**') || '';
      const payoutNumber = parseFloat(String(payoutRaw).replace('€', '').replace(',', '.'));

      const payload = {
        orderId: get('**Order:**'),
        productName: get('**Product:**'),
        sku: get('**SKU:**'),
        size: get('**Size:**'),
        brand: get('**Brand:**'),
        payout: payoutNumber,
        sellerCode,
        discordUserId,
        vatType: get('**VAT Type:**') || null,
        imageUrl: embed.image?.url || null
      };

      await fetch(PROCESS_DEAL_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(() => null);

      const disabledComponents = interaction.message.components.map((row) =>
        new ActionRowBuilder().addComponents(
          ...row.components.map((comp) => ButtonBuilder.from(comp).setDisabled(true))
        )
      );

      await interaction.message.edit({ components: disabledComponents }).catch(() => null);

      const finalPayout = Number.isFinite(payload.payout) ? payload.payout : null;
      const payoutLine = finalPayout !== null ? `Final payout: €${finalPayout.toFixed(2)}` : 'Final payout: see deal details above';

      const infoMsg =
        `✅ Deal processed!\n\n` +
        `💶\n${payoutLine}\n\n` +
        `📦\nThe shipping label will be sent shortly.\n\n` +
        `📬\nPlease prepare the package and ensure it is packed in a clean, unbranded box with no unnecessary stickers or markings. REMOVE ANY PRICETAGS!\n\n` +
        `❌\nDo not include anything inside the box, as this is not a standard deal.\n\n` +
        `📸\nPlease pack it as professionally as possible. If you're unsure, feel free to take a photo of the package and share it here before shipping.`;

      await interaction.channel?.send({ content: `<@${discordUserId}>\n\n${infoMsg}` });

      return interaction.reply({ content: '✅ Deal processed and instructions sent in this channel.', ephemeral: true });
    }

    /* ---- OFFER BUTTON ---- */
    if (interaction.isButton() && interaction.customId === 'seller_offer') {
      const messageId = interaction.message.id;

      let orderRecord = null;
      try {
        const recs = await base(ordersTableName)
          .select({
            filterByFormula: `SEARCH("${messageId}", {${ORDER_FIELD_SELLER_MSG_IDS}})`,
            maxRecords: 1
          })
          .firstPage();
        orderRecord = recs[0] || null;
      } catch (_) {}

      let offerPlaceholder = 'Enter your offer (e.g. 140)';
      if (orderRecord) {
        const currentLowestRaw = orderRecord.get(ORDER_FIELD_CURRENT_LOWEST_OFFER);
        if (currentLowestRaw) offerPlaceholder = `Current Lowest Offer: ${currentLowestRaw}`;
      }

      const modal = new ModalBuilder()
        .setCustomId(`seller_offer_modal:${messageId}`)
        .setTitle('Enter Seller ID, VAT & Offer');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('seller_id')
            .setLabel('Seller ID (e.g. 00001)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('vat_type')
            .setLabel('VAT Type (Margin / VAT0 / VAT21)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('offer_price')
            .setLabel('Your Offer (€)')
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder(offerPlaceholder)
        )
      );

      await interaction.showModal(modal);
      return;
    }

    /* ---- OFFER MODAL SUBMISSION ---- */
    if (interaction.isModalSubmit() && interaction.customId.startsWith('seller_offer_modal:')) {
      const [, messageId] = interaction.customId.split(':');

      let orderRecord = null;
      try {
        const recs = await base(ordersTableName)
          .select({
            filterByFormula: `SEARCH("${messageId}", {${ORDER_FIELD_SELLER_MSG_IDS}})`,
            maxRecords: 1
          })
          .firstPage();
        orderRecord = recs[0] || null;
      } catch (_) {}

      const orderId = orderRecord?.id || null;

      const sellerDigits = interaction.fields.getTextInputValue('seller_id').trim();
      const retryCustomId =
        interaction.guildId && interaction.channelId
          ? `retry_offer:${interaction.guildId}:${interaction.channelId}:${messageId}`
          : null;

      if (!/^\d+$/.test(sellerDigits)) {
        const msg = '❌ Seller ID must be digits only.';
        await interaction.reply({ content: msg, ephemeral: true });
        await safeDMWithRetry(interaction.user, `${msg}\n\nYou can try again by clicking the button below.`, retryCustomId);
        return;
      }

      const sellerCode = `SE-${sellerDigits}`;

      const vatInput = normalizeVatType(interaction.fields.getTextInputValue('vat_type').trim());
      if (!vatInput) {
        const msg = '❌ VAT Type must be one of: Margin, VAT0, VAT21.';
        await interaction.reply({ content: msg, ephemeral: true });
        await safeDMWithRetry(interaction.user, `${msg}\n\nYou can try again by clicking the button below.`, retryCustomId);
        return;
      }

      const offerPrice = parseFloat(interaction.fields.getTextInputValue('offer_price').replace(',', '.'));
      if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
        const msg = '❌ Invalid offer price.';
        await interaction.reply({ content: msg, ephemeral: true });
        await safeDMWithRetry(interaction.user, `${msg}\n\nYou can try again by clicking the button below.`, retryCustomId);
        return;
      }

      const normalizedOffer = getNormalized(offerPrice, vatInput);

      // undercut logic
      if (orderId) {
        const lowest = await getCurrentLowest(orderId);
        if (lowest) {
          const maxAllowedGross = lowest.normalized - MIN_UNDERCUT_STEP;

          if (normalizedOffer > maxAllowedGross + 1e-9) {
            const lowestStr = formatLowestForDisplay(lowest);

            let maxForSeller = maxAllowedGross;
            if (vatInput === 'VAT0') maxForSeller = maxAllowedGross / 1.21;

            const maxForSellerRounded = Math.floor(maxForSeller * 100) / 100;

            let maxDisplay = `€${maxForSellerRounded.toFixed(2)} (${vatInput})`;
            let altDisplay = '';

            if (vatInput === 'VAT0') {
              altDisplay = ` / ≈€${(maxForSellerRounded * 1.21).toFixed(2)} (Margin)`;
            } else if (vatInput === 'VAT21') {
              altDisplay = ` / ≈€${(maxForSellerRounded / 1.21).toFixed(2)} (VAT0)`;
            }

            const msg =
              `❌ Offer too high.\n` +
              `Current lowest: **${lowestStr}**\n` +
              `Your offer must be at least **€${MIN_UNDERCUT_STEP.toFixed(2)}** lower than that.\n` +
              `Max allowed for your VAT type: **${maxDisplay}${altDisplay}**.`;

            await interaction.reply({ content: msg, ephemeral: true });
            await safeDMWithRetry(interaction.user, `${msg}\n\nYour offer was **not** saved. You can try again by clicking the button below.`, retryCustomId);
            return;
          }
        }
      }

      // lookup seller
      const sellers = await base(sellersTableName)
        .select({ filterByFormula: `{Seller ID} = "${sellerCode}"`, maxRecords: 1 })
        .firstPage();

      const sellerRecordId = sellers[0]?.id;
      if (!sellerRecordId) {
        const msg = `❌ Seller ${sellerCode} not found.`;
        await interaction.reply({ content: msg, ephemeral: true });
        await safeDMWithRetry(interaction.user, `${msg}\n\nPlease check your Seller ID and try again by clicking the button below.`, retryCustomId);
        return;
      }

      const fields = {
        'Seller Offer': offerPrice,
        'Offer VAT Type': vatInput,
        'Offer Cost (Normalized)': normalizedOffer,
        'Offer Date': new Date().toISOString().split('T')[0],
        'Seller ID': [sellerRecordId],
        'Seller Discord ID': interaction.user.id
      };

      if (orderId) fields['Linked Orders'] = [orderId];

      await base(sellerOffersTableName).create(fields);

      await interaction.reply({
        content: `✅ Offer submitted.\nSeller: ${sellerCode}\nOffer: €${offerPrice.toFixed(2)} (${vatInput})`,
        ephemeral: true
      });

      // DM confirmation
      try {
        const dmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel('Go To WTB').setStyle(ButtonStyle.Link).setURL(WTB_URL)
        );

        await interaction.user.send({
          content:
            `Hi ${interaction.user}, your offer has been placed successfully.\n` +
            `If your offer gets accepted, we'll open a private channel with you to confirm the deal.\n\n` +
            `In the meantime you can keep an eye on our WTB page to see if your offer is still the lowest:`,
          components: [dmRow]
        });
      } catch (e) {
        console.warn('DM confirmation failed:', e?.message || e);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
  }
});

/* ---------------- Start HTTP server ---------------- */

app.listen(PORT, () => console.log(`🌐 WTB Seller Offers Bot running on port ${PORT}`));
