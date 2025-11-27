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

function getNormalized(price, vatType) {
  if (!Number.isFinite(price)) return null;
  if (vatType === 'VAT0') return price * 1.21;
  return price;
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

  await base(ordersTableName).update(orderId, { [ORDER_FIELD_BUTTONS_DISABLED]: true }).catch(() => null);
}

/* ---------------- Lowest offer calculation ---------------- */

async function getCurrentLowest(orderId) {
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

  return best;
}

/* ---------------- Express API ---------------- */

const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.send('WTB Seller Offers Bot OK'));

/* ---------------- POST /partner-offer-deal ---------------- */

async function sendOfferDeal(req, res) {
  try {
    const { productName, sku, size, brand, imageUrl, recordId } = req.body || {};

    const embed = new EmbedBuilder()
      .setTitle('🔥 NEW WTB DEAL (OFFER ONLY)')
      .setDescription(
        `**${productName}**\n${sku}\n${size}\n${brand}\n\nClick below to submit your offer.`
      )
      .setColor(0xf1c40f);

    if (imageUrl) embed.setImage(imageUrl);

    const messageIds = [];

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
    }

    if (recordId) {
      await base(ordersTableName).update(recordId, {
        [ORDER_FIELD_SELLER_MSG_IDS]: messageIds.join(','),
        [ORDER_FIELD_BUTTONS_DISABLED]: false
      });
    }

    return res.json({ ok: true, messageIds });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

app.post('/partner-offer-deal', sendOfferDeal);
app.post('/partner-deal', sendOfferDeal);

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
        { id: discordUserId, allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]}
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
        payout: parseFloat(get('**Payout:**').replace('€','')),
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

    /* ---- OFFER BUTTON ---- */
    if (interaction.isButton() && interaction.customId === 'seller_offer') {
      const messageId = interaction.message.id;

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
        )
      );

      await interaction.showModal(modal);
      return;
    }

    /* ---- OFFER MODAL SUBMISSION ---- */
    if (interaction.isModalSubmit() && interaction.customId.startsWith('seller_offer_modal:')) {
      const [_, messageId] = interaction.customId.split(':');

      // find the matching order
      let orderRecord = null;
      try {
        const recs = await base(ordersTableName)
          .select({
            filterByFormula: `SEARCH("${messageId}", {${ORDER_FIELD_SELLER_MSG_IDS}})`,
            maxRecords: 1
          })
          .firstPage();

        orderRecord = recs[0];
      } catch (_) {}

      const orderId = orderRecord?.id || null;

      const sellerDigits = interaction.fields.getTextInputValue('seller_id').trim();
      if (!/^\d+$/.test(sellerDigits)) {
        return interaction.reply({
          content: '❌ Seller ID must be digits only.',
          ephemeral: true
        });
      }

      const sellerCode = `SE-${sellerDigits}`;

      const vatInput = normalizeVatType(
        interaction.fields.getTextInputValue('vat_type').trim()
      );
      if (!vatInput) {
        return interaction.reply({
          content: '❌ VAT Type must be one of: Margin, VAT0, VAT21.',
          ephemeral: true
        });
      }

      const offerPrice = parseFloat(
        interaction.fields.getTextInputValue('offer_price')
          .replace(',', '.')
      );

      if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
        return interaction.reply({
          content: '❌ Invalid offer price.',
          ephemeral: true
        });
      }

      const normalizedOffer = getNormalized(offerPrice, vatInput);

      // undercut logic
      if (orderId) {
        const lowest = await getCurrentLowest(orderId);
        if (lowest) {
          const maxAllowed = lowest.normalized - MIN_UNDERCUT_STEP;
          if (normalizedOffer > maxAllowed) {
            return interaction.reply({
              content:
                `❌ Offer too high.\nCurrent lowest normalized: €${lowest.normalized.toFixed(2)}\n` +
                `Your max allowed: €${maxAllowed.toFixed(2)}`,
              ephemeral: true
            });
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
        return interaction.reply({
          content: `❌ Seller ${sellerCode} not found.`,
          ephemeral: true
        });
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

      return interaction.reply({
        content:
          `✅ Offer submitted.\n` +
          `Seller: ${sellerCode}\n` +
          `Offer: €${offerPrice.toFixed(2)} (${vatInput})`,
        ephemeral: true
      });
    }
  } catch (err) {
    console.error('Interaction error:', err);
  }
});

/* ---------------- Start HTTP server ---------------- */

app.listen(PORT, () =>
  console.log(`🌐 WTB Seller Offers Bot running on port ${PORT}`)
);
