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
  DISCORD_DEALS_CHANNEL_ID, // comma-separated IDs
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_INVENTORY_TABLE,
  AIRTABLE_PARTNER_OFFERS_TABLE,
  AIRTABLE_SELLERS_TABLE,
  AIRTABLE_ORDERS_TABLE,
  PAYOUT_CATEGORY_ID = '1417200728069378078',
  PROCESS_DEAL_WEBHOOK_URL,
  PORT = 10000
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_DEALS_CHANNEL_ID || !AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
  console.error('❌ Missing required environment variables.');
  process.exit(1);
}

// Allow multiple deal channels (comma-separated)
const dealsChannelIds = DISCORD_DEALS_CHANNEL_ID.split(',')
  .map(id => id.trim())
  .filter(Boolean);

if (dealsChannelIds.length === 0) {
  console.error('❌ No valid DISCORD_DEALS_CHANNEL_ID(s) provided.');
  process.exit(1);
}

/* ---------------- Airtable ---------------- */

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const inventoryTableName = AIRTABLE_INVENTORY_TABLE || 'Inventory Units';
const partnerOffersTableName = AIRTABLE_PARTNER_OFFERS_TABLE || 'Partner Offers';
const sellersTableName = AIRTABLE_SELLERS_TABLE || 'Sellers Database';
const ordersTableName = AIRTABLE_ORDERS_TABLE || 'Unfulfilled Orders Log';

/* ---------------- Discord ---------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, c => {
  console.log(`🤖 Partner Deal Bot logged in as ${c.user.tag}`);
});

client.login(DISCORD_TOKEN);

/* ---------------- Helpers ---------------- */

/**
 * Extract value from description lines like:
 *  "**SKU:** 1234"
 * with label = "**SKU:**"
 */
function getValueFromLines(lines, label) {
  const line = lines.find(l => l.startsWith(label));
  if (!line) return '';
  return line.split(label)[1].trim();
}

/**
 * Find order record based on one of its Discord message IDs.
 * Works even if Partner Deal Message ID stores multiple IDs (comma-separated).
 */
async function findOrderRecordIdByMessageId(messageId) {
  const records = await base(ordersTableName)
    .select({
      maxRecords: 1,
      filterByFormula: `SEARCH("${messageId}", {Partner Deal Message ID})`
    })
    .firstPage();

  return records[0]?.id || null;
}

/**
 * Find Seller record in Sellers Database by Seller Code (e.g. "SE-00385")
 * Assumes primary / first column in Sellers Database is "Seller ID"
 */
async function findSellerRecordIdByCode(sellerCode) {
  if (!sellerCode) return null;

  const sellersTable = base(sellersTableName);

  const records = await sellersTable
    .select({
      maxRecords: 1,
      filterByFormula: `{Seller ID} = "${sellerCode}"`
    })
    .firstPage();

  if (!records || records.length === 0) return null;
  return records[0].id;
}

/* ---- Seller webhook helpers ---- */

const SELLER_WEBHOOK_FIELD_NAME = 'Discord Webhook URL'; // field in Sellers Database

async function getSellerWebhookUrlByRecordId(sellerRecordId) {
  if (!sellerRecordId) return null;

  const sellersTable = base(sellersTableName);
  try {
    const rec = await sellersTable.find(sellerRecordId);
    const url = rec.get(SELLER_WEBHOOK_FIELD_NAME);
    return typeof url === 'string' && url.trim() ? url.trim() : null;
  } catch (e) {
    console.error('Failed to read seller webhook URL:', e);
    return null;
  }
}

async function sendSellerClaimWebhook({
  webhookUrl,
  productName,
  sku,
  size,
  brand,
  sellerCode,
  startPayout,
  dealId
}) {
  if (!webhookUrl) return;

  const embed = {
    title: '✅ DEAL CONFIRMED ✅',
    description:
      `**${productName}**\n` +
      `${sku}\n` +
      `${size}\n` +
      `${brand}`,
    color: 16776960, // yellow
    fields: [
      {
        name: 'Confirmed Deal Price',
        value: `€${startPayout.toFixed(2)}`,
        inline: false
      }
    ]
  };

  const body = {
    content: `New deal claimed by \`${sellerCode}\`${dealId ? ` • Order ID: \`${dealId}\`` : ''}`,
    embeds: [embed]
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    console.error('Failed to send seller claim webhook:', e);
  }
}

/**
 * Build the action row with Claim / Offer buttons.
 * If disabled=true, both buttons are disabled (dark grey).
 */
function buildButtonsRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('partner_claim')
      .setLabel('Claim Deal')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('partner_offer')
      .setLabel('Offer')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

/**
 * Build an action row with only the Offer button.
 */
function buildOfferOnlyRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('partner_offer')
      .setLabel('Offer')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

/**
 * Disable all deal messages (in all deal channels) for a given order record ID.
 * Uses the comma-separated "Partner Deal Message ID" field.
 */
async function disableDealMessagesForRecord(orderRecordId) {
  const orderRecord = await base(ordersTableName).find(orderRecordId);
  if (!orderRecord) {
    console.warn(`⚠️ Order record not found for disable: ${orderRecordId}`);
    return;
  }

  const messageIdsRaw = orderRecord.get('Partner Deal Message ID');
  if (!messageIdsRaw) {
    console.warn(`⚠️ No Partner Deal Message ID stored on order: ${orderRecordId}`);
    return;
  }

  const messageIds = String(messageIdsRaw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (messageIds.length === 0) {
    console.warn(`⚠️ No valid message IDs parsed for order: ${orderRecordId}`);
    return;
  }

  for (const channelId of dealsChannelIds) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) continue;

    for (const msgId of messageIds) {
      const msg = await channel.messages.fetch(msgId).catch(() => null);
      if (!msg) continue;

      const disabledComponents = msg.components.map(row =>
        new ActionRowBuilder().addComponents(
          ...row.components.map(btn =>
            ButtonBuilder.from(btn).setDisabled(true)
          )
        )
      );

      await msg.edit({ components: disabledComponents });
    }
  }
}

/* ---------------- Express HTTP API ---------------- */

const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) =>
  res.type('text/plain').send('Partner Deal Bot OK')
);

app.get('/health', (_req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

/**
 * POST /partner-deal
 * → Full Claim + Offer buttons
 */
app.post('/partner-deal', async (req, res) => {
  try {
    const {
      productName,
      sku,
      size,
      brand,
      startPayout,
      imageUrl,
      dealId,
      recordId
    } = req.body || {};

    if (!productName || !sku || !size || !brand || !startPayout) {
      return res.status(400).json({ error: 'Missing required fields in payload.' });
    }

    const descriptionLines = [
      `**Product Name:** ${productName}`,
      `**SKU:** ${sku}`,
      `**Size:** ${size}`,
      `**Brand:** ${brand}`,
      `**Payout:** €${Number(startPayout).toFixed(2)}`,
      dealId ? `**Order ID:** ${dealId}` : null
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle('🧨 NEW DEAL 🧨')
      .setDescription(descriptionLines.join('\n'))
      .setColor(0xf1c40f);

    if (imageUrl) {
      embed.setImage(imageUrl);
    }

    const messageIds = [];

    for (const channelId of dealsChannelIds) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        console.warn(`⚠️ Deals channel ${channelId} not found or not text-based.`);
        continue;
      }

      const msg = await channel.send({
        embeds: [embed],
        components: [buildButtonsRow(false)]
      });

      messageIds.push(msg.id);
    }

    if (messageIds.length === 0) {
      return res.status(500).json({ error: 'No valid deal channels available.' });
    }

    if (recordId) {
      try {
        await base(ordersTableName).update(recordId, {
          'Partner Deal Message ID': messageIds.join(','),
          'Partner Deal Buttons Disabled': false
        });
      } catch (e) {
        console.error('Failed to update order record with message IDs / reset flag:', e);
      }
    }

    return res.json({ ok: true, messageIds });
  } catch (err) {
    console.error('Error in /partner-deal:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
});

/**
 * POST /partner-offer-deal
 * → Offer-only button (no Claim)
 */
app.post('/partner-offer-deal', async (req, res) => {
  try {
    const {
      productName,
      sku,
      size,
      brand,
      startPayout,
      imageUrl,
      dealId,
      recordId
    } = req.body || {};

    if (!productName || !sku || !size || !brand || !startPayout) {
      return res.status(400).json({ error: 'Missing required fields in payload.' });
    }

    const descriptionLines = [
      `**Product Name:** ${productName}`,
      `**SKU:** ${sku}`,
      `**Size:** ${size}`,
      `**Brand:** ${brand}`,
      `**Payout:** €${Number(startPayout).toFixed(2)}`,
      dealId ? `**Order ID:** ${dealId}` : null
    ].filter(Boolean);

    const embed = new EmbedBuilder()
      .setTitle('🧨 NEW DEAL (OFFER ONLY) 🧨')
      .setDescription(descriptionLines.join('\n'))
      .setColor(0xf1c40f);

    if (imageUrl) {
      embed.setImage(imageUrl);
    }

    const messageIds = [];

    for (const channelId of dealsChannelIds) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        console.warn(`⚠️ Deals channel ${channelId} not found or not text-based.`);
        continue;
      }

      const msg = await channel.send({
        embeds: [embed],
        components: [buildOfferOnlyRow(false)]
      });

      messageIds.push(msg.id);
    }

    if (messageIds.length === 0) {
      return res.status(500).json({ error: 'No valid deal channels available.' });
    }

    if (recordId) {
      try {
        await base(ordersTableName).update(recordId, {
          'Partner Deal Message ID': messageIds.join(','),
          'Partner Deal Buttons Disabled': false
        });
      } catch (e) {
        console.error('Failed to update order record with message IDs / reset flag (offer-only):', e);
      }
    }

    return res.json({ ok: true, messageIds });
  } catch (err) {
    console.error('Error in /partner-offer-deal:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
});

/**
 * POST /partner-deal/disable
 */
app.post('/partner-deal/disable', async (req, res) => {
  try {
    const { recordId } = req.body || {};
    if (!recordId) {
      return res.status(400).json({ error: 'Missing recordId.' });
    }

    await disableDealMessagesForRecord(recordId);

    try {
      await base(ordersTableName).update(recordId, {
        'Partner Deal Buttons Disabled': true
      });
    } catch (e) {
      console.error('Failed to set Partner Deal Buttons Disabled = true:', e);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error in /partner-deal/disable:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
});

/**
 * POST /payout-channel
 *
 * Wordt vanuit Make aangeroepen om een privé payout-kanaal te maken.
 *
 * Payload:
 * {
 *   "orderId": "ORD-002067",
 *   "productName": "...",
 *   "sku": "...",
 *   "size": "...",
 *   "brand": "...",
 *   "payout": 135,
 *   "sellerCode": "SE-00113",
 *   "imageUrl": "https://...",
 *   "discordUserId": "123456789012345678"
 * }
 */
app.post('/payout-channel', async (req, res) => {
  try {
    const {
      orderId,
      productName,
      sku,
      size,
      brand,
      payout,
      sellerCode,
      imageUrl,
      discordUserId,
      vatType
    } = req.body || {};

    if (!orderId || !productName || !sku || !size || !brand || !payout || !sellerCode || !discordUserId) {
      return res.status(400).json({ error: 'Missing required fields in payload.' });
    }

    const category = await client.channels.fetch(PAYOUT_CATEGORY_ID).catch(() => null);
    if (!category || !category.guild) {
      return res.status(500).json({ error: 'Payout category not found or no guild.' });
    }
    const guild = category.guild;

    const baseName = `payout-${orderId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const channelName = baseName.substring(0, 90) || 'payout-deal';

    // Ensure the user is cached, otherwise permission overwrite fails
    await guild.members.fetch(discordUserId).catch(() => null);

    const channel = await guild.channels.create({
      name: channelName,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [PermissionsBitField.Flags.ViewChannel]
        },
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

    const descLines = [
      `**Order:** ${orderId}`,
      `**Product:** ${productName}`,
      `**SKU:** ${sku}`,
      `**Size:** ${size}`,
      `**Brand:** ${brand}`,
      `**Payout:** €${Number(payout).toFixed(2)}`,
      `**Seller:** ${sellerCode}`,
      vatType ? `**VAT Type:** ${vatType}` : null   // 👈 NEW (optional line)
    ];

    const embed = new EmbedBuilder()
      .setTitle('✅ Offer Accepted')
      .setDescription(descLines.join('\n'))
      .setColor(0x57F287);

    if (imageUrl) {
      embed.setImage(imageUrl);
    }

    const processCustomId = `process_payout:${orderId}:${sellerCode}:${discordUserId}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(processCustomId)
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
    return res.status(500).json({ error: 'Internal error.' });
  }
});

/* ---------------- Discord Interaction Logic ---------------- */

client.on(Events.InteractionCreate, async interaction => {
  try {
    /* ---------- BUTTONS ---------- */
    if (interaction.isButton()) {
      // ---- Process Deal button in payout-kanalen ----
      if (interaction.customId.startsWith('process_payout:')) {
        try {
          if (!PROCESS_DEAL_WEBHOOK_URL) {
            await interaction.reply({
              content: '❌ No PROCESS_DEAL_WEBHOOK_URL configured on the bot.',
              ephemeral: true
            });
            return;
          }

          const [, orderId, sellerCode, userId] = interaction.customId.split(':');

          const embed = interaction.message.embeds?.[0];
          if (!embed || !embed.description) {
            await interaction.reply({
              content: '❌ Missing deal details on this message.',
              ephemeral: true
            });
            return;
          }

          const lines = embed.description.split('\n');

          const orderIdFromEmbed = getValueFromLines(lines, '**Order:**') || orderId;
          const productName = getValueFromLines(lines, '**Product:**');
          const sku = getValueFromLines(lines, '**SKU:**');
          const size = getValueFromLines(lines, '**Size:**');
          const brand = getValueFromLines(lines, '**Brand:**');
          const payoutRaw = getValueFromLines(lines, '**Payout:**');
          const sellerCodeFromEmbed = getValueFromLines(lines, '**Seller:**') || sellerCode;
          const vatType = getValueFromLines(lines, '**VAT Type:**');  // 👈 NEW

          let payoutNum = null;
          if (payoutRaw) {
            payoutNum = parseFloat(
              payoutRaw
                .replace('€', '')
                .replace(',', '.')
                .replace(/[^\d.-]/g, '')
            );
          }

          const imageUrl = embed.image?.url || null;

          const payload = {
            orderId: orderIdFromEmbed,
            productName,
            sku,
            size,
            brand,
            payout: payoutNum,
            sellerCode: sellerCodeFromEmbed,
            discordUserId: userId,
            imageUrl,
            vatType
          };

          await fetch(PROCESS_DEAL_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });

          await interaction.reply({
            content: '✅ Deal sent to processing.',
            ephemeral: true
          });
        } catch (err) {
          console.error('Error handling process_payout button:', err);
          try {
            await interaction.reply({
              content: '❌ Failed to send deal to processing.',
              ephemeral: true
            });
          } catch (_) {}
        }
        return;
      }

      // ---- Bestaande Claim / Offer buttons in deals-kanalen ----
      if (
        !dealsChannelIds.includes(interaction.channelId) ||
        !['partner_claim', 'partner_offer'].includes(interaction.customId)
      ) {
        return;
      }

      const messageId = interaction.message.id;
      const embed = interaction.message.embeds?.[0];

      if (!embed) {
        try {
          await interaction.reply({
            content: '❌ No deal embed found.',
            ephemeral: true
          });
        } catch (err) {
          if (err.code === 10062) {
            console.warn('⚠️ Unknown/expired interaction (no embed), ignoring.');
          } else {
            throw err;
          }
        }
        return;
      }

      // CLAIM DEAL button
      if (interaction.customId === 'partner_claim') {
        const modal = new ModalBuilder()
          .setCustomId(`partner_claim_modal:${messageId}`)
          .setTitle('Enter Seller ID');

        const sellerIdInput = new TextInputBuilder()
          .setCustomId('seller_id')
          .setLabel('Seller ID (e.g. 00001)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('00001');

        const row = new ActionRowBuilder().addComponents(sellerIdInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
        return;
      }

      // OFFER button
      if (interaction.customId === 'partner_offer') {
        const modal = new ModalBuilder()
          .setCustomId(`partner_offer_modal:${messageId}`)
          .setTitle('Enter Seller ID & Offer');

        const sellerIdInput = new TextInputBuilder()
          .setCustomId('seller_id')
          .setLabel('Seller ID (e.g. 00001)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('00001');

        const offerInput = new TextInputBuilder()
          .setCustomId('offer_price')
          .setLabel('Your Offer (€)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('140');

        const row1 = new ActionRowBuilder().addComponents(sellerIdInput);
        const row2 = new ActionRowBuilder().addComponents(offerInput);

        modal.addComponents(row1, row2);

        await interaction.showModal(modal);
        return;
      }
    }

    /* ---------- MODALS ---------- */
    if (interaction.isModalSubmit()) {
      // Alleen in de deals-kanalen
      if (
        !dealsChannelIds.includes(interaction.channelId) ||
        !interaction.customId.startsWith('partner_')
      ) {
        return;
      }

      const [prefix, messageId] = interaction.customId.split(':');

      const channel = interaction.channel;
      if (!channel || !channel.isTextBased()) {
        await interaction.reply({
          content: '❌ Could not find the original deal message.',
          ephemeral: true
        });
        return;
      }

      const msg = await channel.messages.fetch(messageId).catch(() => null);
      const embed = msg?.embeds?.[0];

      if (!embed || !embed.description) {
        await interaction.reply({ content: '❌ Missing deal details.', ephemeral: true });
        return;
      }

      const lines = embed.description.split('\n');

      const productName = getValueFromLines(lines, '**Product Name:**');
      const sku = getValueFromLines(lines, '**SKU:**');
      const size = getValueFromLines(lines, '**Size:**');
      const brand = getValueFromLines(lines, '**Brand:**');
      const startPayout = parseFloat(
        getValueFromLines(lines, '**Payout:**')
          ?.replace('€', '')
          ?.replace(',', '.') || '0'
      );

      const dealId = getValueFromLines(lines, '**Order ID:**') || messageId;
      const orderRecordId = await findOrderRecordIdByMessageId(messageId);

      const sellerNumberRaw = interaction.fields.getTextInputValue('seller_id').trim();

      if (!/^\d+$/.test(sellerNumberRaw)) {
        await interaction.reply({
          content: '❌ Seller Number must contain digits only (no SE-, just the digits). Please try again.',
          ephemeral: true
        });
        return;
      }

      const sellerCode = `SE-${sellerNumberRaw}`;
      const sellerRecordId = await findSellerRecordIdByCode(sellerCode);
      if (!sellerRecordId) {
        await interaction.reply({
          content: `❌ Could not find a seller with ID \`${sellerCode}\` in Sellers Database.`,
          ephemeral: true
        });
        return;
      }

      /* ---- CLAIM DEAL MODAL ---- */
      if (prefix === 'partner_claim_modal') {
        const fields = {
          'Product Name': productName,
          'SKU': sku,
          'Size': size,
          'Brand': brand,
          'VAT Type': 'Margin',
          'Purchase Price': startPayout,
          'Shipping Deduction': 0,
          'Ticket Number': dealId,
          'Purchase Date': new Date().toISOString().split('T')[0],
          'Source': 'Outsourced',
          'Verification Status': 'Verified',
          'Payment Note': startPayout.toFixed(2).replace('.', ','),
          'Payment Status': 'To Pay',
          'Availability Status': 'Reserved',
          'Margin %': '10%',
          'Type': 'Custom',
          'Seller ID': [sellerRecordId]
        };

        if (orderRecordId) {
          fields['Unfulfilled Orders Log'] = [orderRecordId];
        }

        await base(inventoryTableName).create(fields);

        // seller-webhook (optioneel)
        const sellerWebhookUrl = await getSellerWebhookUrlByRecordId(sellerRecordId);
        await sendSellerClaimWebhook({
          webhookUrl: sellerWebhookUrl,
          productName,
          sku,
          size,
          brand,
          sellerCode,
          startPayout,
          dealId
        });

        // Disable buttons in alle deal-kanalen voor deze order
        if (orderRecordId) {
          try {
            await disableDealMessagesForRecord(orderRecordId);
            await base(ordersTableName).update(orderRecordId, {
              'Partner Deal Buttons Disabled': true
            });
          } catch (e) {
            console.error('Failed to globally disable buttons after claim:', e);
          }
        } else {
          try {
            if (msg) {
              const disabledComponents = msg.components.map(row =>
                new ActionRowBuilder().addComponents(
                  ...row.components.map(btn =>
                    ButtonBuilder.from(btn).setDisabled(true)
                  )
                )
              );
              await msg.edit({ components: disabledComponents });
            }
          } catch (e) {
            console.error('Failed to disable buttons after claim (no orderRecordId):', e);
          }
        }

        await interaction.reply({
          content: `✅ Deal claimed for **${productName} (${size})**.\nSeller: \`${sellerCode}\``,
          ephemeral: true
        });
        return;
      }

      /* ---- OFFER MODAL ---- */
      if (prefix === 'partner_offer_modal') {
        const rawOffer = interaction.fields.getTextInputValue('offer_price').trim();
        const offerPrice = parseFloat(rawOffer.replace(',', '.') || '0');

        const fields = {
          'Partner Offer': offerPrice,
          'Offer Date': new Date().toISOString().split('T')[0],
          'Seller ID': [sellerRecordId]
        };

        if (orderRecordId) {
          fields['Linked Orders'] = [orderRecordId];
        }

        await base(partnerOffersTableName).create(fields);

        await interaction.reply({
          content:
            `✅ Offer submitted for **${productName} (${size})**.\n` +
            `Seller: \`${sellerCode}\`\n` +
            `Offer: €${offerPrice.toFixed(2)}`,
          ephemeral: true
        });
        return;
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable()) {
      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({
            content: '❌ Something went wrong handling this interaction.',
            ephemeral: true
          });
        } else {
          await interaction.reply({
            content: '❌ Something went wrong handling this interaction.',
            ephemeral: true
          });
        }
      } catch (_) {}
    }
  }
});

/* ---------------- Start HTTP server ---------------- */

app.listen(PORT, () => {
  console.log(`🌐 Partner Deal Bot HTTP server running on port ${PORT}`);
});
