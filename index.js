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
  DISCORD_PARTNER_WTB_CHANNEL_ID,          // 👈 NEW: partner WTB channels
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_SELLER_OFFERS_TABLE,
  AIRTABLE_SELLERS_TABLE,
  AIRTABLE_ORDERS_TABLE,
  PAYOUT_CATEGORY_ID,
  PROCESS_DEAL_WEBHOOK_URL,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_DEALS_CHANNEL_ID || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('❌ Missing required environment variables.');
  process.exit(1);
}

const dealsChannelIds = DISCORD_DEALS_CHANNEL_ID.split(',')
  .map(id => id.trim())
  .filter(Boolean);

// 👇 NEW: partner WTB channels (for “Go To Server” embeds)
const partnerWtbChannelIds = (DISCORD_PARTNER_WTB_CHANNEL_ID || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const WTB_URL =
  'https://airtable.com/invite/l?inviteId=invwmhpKlD6KmJe6n&inviteToken=a14697b7435e64f6ee429f8b59fbb07bc0474aaf66c8ff59068aa5ceb2842253&utm_medium=email&utm_source=product_team&utm_content=transactional-alerts';


/* ---------------- Airtable ---------------- */

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const sellerOffersTableName = AIRTABLE_SELLER_OFFERS_TABLE || 'Seller Offers';
const sellersTableName      = AIRTABLE_SELLERS_TABLE       || 'Sellers Database';
const ordersTableName       = AIRTABLE_ORDERS_TABLE        || 'Unfulfilled Orders Log';

const ORDER_FIELD_SELLER_MSG_IDS   = 'Seller Offer Message ID';
const ORDER_FIELD_BUTTONS_DISABLED = 'Seller Offer Buttons Disabled';

/* ---------------- Utilities ---------------- */

const MIN_UNDERCUT_STEP = 2.5;

function normalizeVatType(raw) {
  if (!raw) return null;
  if (raw === 'Margin') return 'Margin';
  if (raw === 'VAT0')   return 'VAT0';
  if (raw === 'VAT21')  return 'VAT21';
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
 * Pretty display string for the current lowest offer, plus the alternative VAT view:
 *  - 230 VAT21 → "€230.00 (Margin) / €190.08 (VAT0)"
 *  - 190 VAT0  → "€190.00 (VAT0) / €229.90 (Margin)"
 */
function formatLowestForDisplay(lowest) {
  if (!lowest || typeof lowest.raw !== 'number') return 'N/A';

  let displayType = lowest.vatType;
  if (lowest.vatType === 'VAT21') {
    displayType = 'Margin';
  }

  const base = `€${lowest.raw.toFixed(2)}${displayType ? ` (${displayType})` : ''}`;

  if (lowest.vatType === 'VAT21') {
    const asVat0 = lowest.raw / 1.21;
    return `${base} / €${asVat0.toFixed(2)} (VAT0)`;
  }

  if (lowest.vatType === 'VAT0') {
    const asVat21 = lowest.raw * 1.21;
    return `${base} / €${asVat21.toFixed(2)} (Margin)`;
  }

  return base;
}

// Safe DM helper with "Retry Offer" button
async function safeDMWithRetry(user, content, retryCustomId) {
  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(retryCustomId)
        .setLabel('Retry Offer')
        .setStyle(ButtonStyle.Primary)
    );
    await user.send({ content, components: [row] });
  } catch (e) {
    console.warn('DM failed:', e.message);
  }
}

// Simple DM helper
async function safeDM(user, content) {
  try {
    await user.send({ content });
  } catch (e) {
    console.warn('DM confirm failed:', e.message);
  }
}


/* ---------------- Discord ---------------- */

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, c => {
  console.log(`🤖 WTB Seller Offer Bot logged in as ${c.user.tag}`);
});

client.login(DISCORD_TOKEN);

/* ---------------- Disable messages ---------------- */

async function disableSellerOfferMessages(orderId) {
  const order = await base(ordersTableName).find(orderId).catch(() => null);
  if (!order) return;

  const rawIds = order.get(ORDER_FIELD_SELLER_MSG_IDS);
  if (!rawIds) return;

  const msgIds = String(rawIds).split(',').map(x => x.trim()).filter(Boolean);

  for (const channelId of dealsChannelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) continue;

    for (const id of msgIds) {
      const msg = await channel.messages.fetch(id).catch(() => null);
      if (!msg) continue;

      const disabled = msg.components.map(row =>
        new ActionRowBuilder().addComponents(
          ...row.components.map(btn => ButtonBuilder.from(btn).setDisabled(true))
        )
      );
      await msg.edit({ components: disabled });
    }
  }

  await base(ordersTableName)
    .update(orderId, { [ORDER_FIELD_BUTTONS_DISABLED]: true })
    .catch(() => null);
}

/* ---------------- Lowest offer calculation ---------------- */

async function getCurrentLowest(orderId) {
  if (!orderId) return null;

  const offers = await base(sellerOffersTableName).select().all();

  let best = null;

  for (const rec of offers) {
    const links = rec.get('Linked Orders');
    if (!Array.isArray(links)) continue;

    const matches = links.some(l => typeof l === 'string' ? l === orderId : l?.id === orderId);
    if (!matches) continue;

    const price = parseNumeric(rec.get('Seller Offer'));
    const vatRaw = rec.get('Offer VAT Type');
    const vat = typeof vatRaw === 'string' ? vatRaw : vatRaw?.name;
    const vatNorm = normalizeVatType(vat);
    const normalized = getNormalized(price, vatNorm);

    if (!Number.isFinite(normalized)) continue;

    if (!best || normalized < best.normalized) {
      best = { normalized, raw: price, vatType: vatNorm };
    }
  }

  if (best) return best;

  // 🔹 Fallback: if there are no offers yet, use order's Maximum Buying Price as baseline
  const order = await base(ordersTableName).find(orderId).catch(() => null);
  if (!order) return null;

  const maxPrice = parseNumeric(order.get('Maximum Buying Price'));
  if (!Number.isFinite(maxPrice)) return null;

  return {
    normalized: maxPrice, // treat this as gross baseline
    raw: maxPrice,
    vatType: 'Margin'
  };
}

/* ---------------- Express API ---------------- */

const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.send('WTB Seller Offers Bot OK'));

/* ---------------- POST /partner-offer-deal ---------------- */
/* (your internal WTB in your own server – unchanged) */

async function sendOfferDeal(req, res) {
  try {
    const { productName, sku, size, brand, imageUrl, recordId } = req.body || {};

    const embed = new EmbedBuilder()
      .setTitle('🔥 NEW WTB DEAL 🔥')
      .setDescription(
        `**${productName}**\n${sku}\n${size}\n${brand}\n\nClick below to submit your offer.`
      )
      .setColor(0xf1c40f);

    if (imageUrl) embed.setImage(imageUrl);

    const messageIds = [];
    const messageUrls = [];

    for (const channelId of dealsChannelIds) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      const msg = await channel.send({
        embeds: [embed],
        components: [
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId('seller_offer')
              .setLabel('Offer')
              .setStyle(ButtonStyle.Success)
          )
        ]
      });

      messageIds.push(msg.id);
      messageUrls.push(msg.url);
    }

    if (recordId) {
      const updateFields = {
        [ORDER_FIELD_SELLER_MSG_IDS]: messageIds.join(','),
        [ORDER_FIELD_BUTTONS_DISABLED]: false
      };

      // Save first message URL as "Offer Message URL"
      if (messageUrls.length > 0) {
        updateFields['Offer Message URL'] = messageUrls[0];
      }

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

/* ---------------- NEW: POST /partner-wtb ---------------- */
/* Sends WTB embed into partner servers with "Go To Server" link button */

app.post('/partner-wtb', async (req, res) => {
  try {
    const { productName, sku, size, brand, imageUrl, recordId } = req.body || {};

    if (!recordId) {
      return res.status(400).json({ error: 'recordId is required' });
    }

    // Get Offer Message URL from Airtable
    const order = await base(ordersTableName).find(recordId).catch(() => null);
    if (!order) {
      return res.status(404).json({ error: 'Order not found in Airtable' });
    }

    const offerMessageUrl = order.get('Offer Message URL');
    if (!offerMessageUrl) {
      return res.status(400).json({ error: 'Offer Message URL is empty for this order' });
    }

    const embed = new EmbedBuilder()
      .setTitle('🔥 NEW WTB DEAL 🔥')
      .setDescription(
        `**${productName}**\n${sku}\n${size}\n${brand}\n\n` +
        `Click below to go to the WTB in our server and place your offer.`
      )
      .setColor(0xf1c40f);

    if (imageUrl) embed.setImage(imageUrl);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Go To Server')
        .setStyle(ButtonStyle.Link)   // link button → no interaction handler needed
        .setURL(offerMessageUrl)
    );

    const sentIds = [];

    for (const channelId of partnerWtbChannelIds) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel) continue;

      const msg = await channel.send({
        embeds: [embed],
        components: [row]
      });

      sentIds.push(msg.id);
    }

    return res.json({ ok: true, messageIds: sentIds });
  } catch (err) {
    console.error('Error in /partner-wtb:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- POST /seller-offer/disable ---------------- */

app.post('/seller-offer/disable', async (req, res) => {
  const { recordId } = req.body;
  if (!recordId) return res.status(400).json({ error: 'Missing recordId' });

  await disableSellerOfferMessages(recordId);
  return res.json({ ok: true });
});

/* ---------------- POST /payout-channel ---------------- */


app.post('/payout-channel', async (req, res) => {
  try {
    const {
      orderId, productName, sku, size, brand,
      payout, sellerCode, imageUrl, discordUserId, vatType
    } = req.body || {};

    const category = await client.channels.fetch(PAYOUT_CATEGORY_ID).catch(() => null);
    if (!category || !category.guild) return res.status(500).json({ error: 'Invalid payout category' });

    const guild = category.guild;

    await guild.members.fetch(discordUserId).catch(() => null);

    const channel = await guild.channels.create({
      name: `wtb-${orderId}`.toLowerCase(),
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

    const embed = new EmbedBuilder()
      .setTitle('✅ Offer Accepted')
      .setDescription(
        `**Order:** ${orderId}\n` +
        `**Product:** ${productName}\n` +
        `**SKU:** ${sku}\n` +
        `**Size:** ${size}\n` +
        `**Brand:** ${brand}\n` +
        `**Payout:** €${Number(payout).toFixed(2)}\n` +
        `**Seller:** ${sellerCode}\n` +
        (vatType ? `**VAT Type:** ${vatType}\n` : '')
      )
      .setColor(0x57F287);

    if (imageUrl) embed.setImage(imageUrl);

    const customId = `process_payout:${orderId}:${sellerCode}:${discordUserId}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel('Process Deal')
        .setStyle(ButtonStyle.Primary)
    );

    await channel.send({
      content: `<@${discordUserId}>`,
      embeds: [embed],
      components: [row]
    });

    return res.json({ ok: true, channelId: channel.id });
  } catch (err) {
    console.error('Error in /payout-channel:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- Discord Interaction Logic ---------------- */

client.on(Events.InteractionCreate, async interaction => {
  try {
    /* ---- PROCESS DEAL BUTTON ---- */
    if (interaction.isButton() && interaction.customId.startsWith('process_payout:')) {
      const [, orderId, sellerCode, discordUserId] = interaction.customId.split(':');

      const embed = interaction.message.embeds?.[0];
      if (!embed || !embed.description) {
        return interaction.reply({
          content: '❌ Missing deal details on this message.',
          ephemeral: true
        });
      }

      const lines = embed.description.split('\n');

      function get(label) {
        const line = lines.find(l => l.startsWith(label));
        return line ? line.replace(label, '').trim() : null;
      }

      const payload = {
        orderId: get('**Order:**'),
        productName: get('**Product:**'),
        sku: get('**SKU:**'),
        size: get('**Size:**'),
        brand: get('**Brand:**'),
        payout: parseFloat((get('**Payout:**') || '').replace('€','')),
        sellerCode,
        discordUserId,
        vatType: get('**VAT Type:**') || null,
        imageUrl: embed.image?.url || null
      };

      await fetch(PROCESS_DEAL_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      return interaction.reply({ content: '✅ Deal sent to processing.', ephemeral: true });
    }

    /* ---- RETRY OFFER BUTTON (in DM) ---- */
    if (interaction.isButton() && interaction.customId.startsWith('retry_offer:')) {
      const [, guildId, channelId, messageId] = interaction.customId.split(':');
      // We only really need messageId; guildId/channelId are just for traceability

      // Find order for placeholder
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

      let lowest = null;
      if (orderRecord?.id) {
        lowest = await getCurrentLowest(orderRecord.id).catch(() => null);
      }

      let offerPlaceholder = 'Enter your offer (e.g. 140)';
      if (lowest) {
        offerPlaceholder = `Current Lowest Offer: ${formatLowestForDisplay(lowest)}`;
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

    /* ---- OFFER BUTTON (in WTB channel) ---- */
    if (interaction.isButton() && interaction.customId === 'seller_offer') {
      const messageId = interaction.message.id;

      // Look up order via Seller Offer Message ID so we can show current lowest
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

      let lowest = null;
      if (orderRecord?.id) {
        lowest = await getCurrentLowest(orderRecord.id).catch(() => null);
      }

      let offerPlaceholder = 'Enter your offer (e.g. 140)';
      if (lowest) {
        offerPlaceholder = `Current Lowest Offer: ${formatLowestForDisplay(lowest)}`;
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
      const [_, messageId] = interaction.customId.split(':');

      const jumpUrl = (interaction.guildId && interaction.channelId && messageId)
        ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${messageId}`
        : null;

      // Find the order for this message
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
        await interaction.reply({
          content: msg,
          ephemeral: true
        });
        if (retryCustomId) {
          await safeDMWithRetry(
            interaction.user,
            `${msg}\n\nYou can try again by clicking the button below.`,
            retryCustomId
          );
        }
        return;
      }

      const sellerCode = `SE-${sellerDigits}`;

      const vatInput = normalizeVatType(
        interaction.fields.getTextInputValue('vat_type').trim()
      );
      if (!vatInput) {
        const msg = '❌ VAT Type must be one of: Margin, VAT0, VAT21.';
        await interaction.reply({
          content: msg,
          ephemeral: true
        });
        if (retryCustomId) {
          await safeDMWithRetry(
            interaction.user,
            `${msg}\n\nYou can try again by clicking the button below.`,
            retryCustomId
          );
        }
        return;
      }

      const offerPrice = parseFloat(
        interaction.fields.getTextInputValue('offer_price').replace(',', '.')
      );

      if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
        const msg = '❌ Invalid offer price.';
        await interaction.reply({
          content: msg,
          ephemeral: true
        });
        if (retryCustomId) {
          await safeDMWithRetry(
            interaction.user,
            `${msg}\n\nYou can try again by clicking the button below.`,
            retryCustomId
          );
        }
        return;
      }

      const normalizedOffer = getNormalized(offerPrice, vatInput);

      // undercut logic with human-friendly messaging
      if (orderId) {
        const lowest = await getCurrentLowest(orderId);
        if (lowest) {
          const maxAllowedGross = lowest.normalized - MIN_UNDERCUT_STEP;

          if (normalizedOffer > maxAllowedGross + 1e-9) {
            const lowestStr = formatLowestForDisplay(lowest);

            // Convert maxAllowedGross into the seller's VAT type
            let maxForSeller = maxAllowedGross;
            if (vatInput === 'VAT0') {
              maxForSeller = maxAllowedGross / 1.21;
            }
            const maxForSellerRounded = Math.floor(maxForSeller * 100) / 100;

            let maxDisplay = `€${maxForSellerRounded.toFixed(2)} (${vatInput})`;
            let altDisplay = '';

            if (vatInput === 'VAT0') {
              const equivMargin = maxForSellerRounded * 1.21;
              altDisplay = ` / ≈€${equivMargin.toFixed(2)} (Margin)`;
            } else if (vatInput === 'VAT21') {
              const equivVat0 = maxForSellerRounded / 1.21;
              altDisplay = ` / ≈€${equivVat0.toFixed(2)} (VAT0)`;
            }


            const msg =
              `❌ Offer too high.\n` +
              `Current lowest: **${lowestStr}**\n` +
              `Your offer must be at least **€${MIN_UNDERCUT_STEP.toFixed(2)}** lower than that.\n` +
              `Max allowed for your VAT type: **${maxDisplay}${altDisplay}**.`;

            await interaction.reply({
              content: msg,
              ephemeral: true
            });

            if (retryCustomId) {
              await safeDMWithRetry(
                interaction.user,
                `${msg}\n\nYour offer was **not** saved. You can try again by clicking the button below.`,
                retryCustomId
              );
            }
            return;
          }
        }
      }

      // lookup seller
      const sellers = await base(sellersTableName)
        .select({
          filterByFormula: `{Seller ID} = "${sellerCode}"`,
          maxRecords: 1
        })
        .firstPage();

      const sellerRecordId = sellers[0]?.id;
      if (!sellerRecordId) {
        const msg = `❌ Seller ${sellerCode} not found.`;
        await interaction.reply({
          content: msg,
          ephemeral: true
        });
        if (retryCustomId) {
          await safeDMWithRetry(
            interaction.user,
            `${msg}\n\nPlease check your Seller ID and try again by clicking the button below.`,
            retryCustomId
          );
        }
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

      // Ephemeral confirmation in the channel
      await interaction.reply({
        content:
          `✅ Offer submitted.\n` +
          `Seller: ${sellerCode}\n` +
          `Offer: €${offerPrice.toFixed(2)} (${vatInput})`,
        ephemeral: true
      });

      // Extra confirmation via DM with a "Go To WTB" button (no Airtable embed)
      try {
        const dmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Go To WTB')
            .setStyle(ButtonStyle.Link) // link-style button → no preview
            .setURL(WTB_URL)
        );

        await interaction.user.send({
          content:
            `Hi ${interaction.user}, your offer has been placed successfully.\n` +
            `If your offer gets accepted, we'll open a private channel with you to confirm the deal.\n\n` +
            `In the meantime you can keep an eye on our WTB page to see if your offer is still the lowest:`,
          components: [dmRow]
        });
      } catch (e) {
        console.warn('DM confirmation failed:', e.message);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
  }
});

/* ---------------- Start HTTP server ---------------- */

app.listen(PORT, () =>
  console.log(`🌐 WTB Seller Offers Bot running on port ${PORT}`)
);
