import 'dotenv/config';
import express from 'express';
import morgan from 'morgan';
import Airtable from 'airtable';
import fetch from 'node-fetch'; // kept for potential future use
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
  Events
} from 'discord.js';

/* ---------------- ENV CONFIG ---------------- */

const {
  DISCORD_TOKEN,
  DISCORD_DEALS_CHANNEL_ID, // can be comma-separated IDs
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  AIRTABLE_INVENTORY_TABLE,        // not used here but kept
  AIRTABLE_SELLER_OFFERS_TABLE,    // Seller Offers table
  AIRTABLE_SELLERS_TABLE,
  AIRTABLE_ORDERS_TABLE,
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

// Tables
const sellerOffersTableName = AIRTABLE_SELLER_OFFERS_TABLE || 'Seller Offers';
const sellersTableName      = AIRTABLE_SELLERS_TABLE       || 'Sellers Database';
const ordersTableName       = AIRTABLE_ORDERS_TABLE        || 'Unfulfilled Orders Log';

// Order fields used by this bot
const ORDER_FIELD_SELLER_MSG_IDS   = 'Seller Offer Message ID';
const ORDER_FIELD_FINAL_OUTSOURCE  = 'Final Outsource Buying Price';
const ORDER_FIELD_BUTTONS_DISABLED = 'Seller Offer Buttons Disabled'; // optional boolean

// Step size for undercutting (change here if you want €5 instead)
const MIN_UNDERCUT_STEP = 2.5;

/* ---------------- Discord ---------------- */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages
  ],
  partials: [Partials.Channel]
});

client.once(Events.ClientReady, c => {
  console.log(`🤖 Seller Offers Bot logged in as ${c.user.tag}`);
});

client.login(DISCORD_TOKEN);

/* ---------------- Helpers ---------------- */

/**
 * Safely parse a numeric field from Airtable (number or string).
 */
function parseNumericField(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = parseFloat(value.replace(',', '.').replace(/[^\d.\-]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Normalize VAT type string from user input.
 * Returns one of "Margin", "VAT0", "VAT21" or null if invalid.
 */
function normalizeVatType(raw) {
  if (!raw) return null;
  const v = raw.trim(); // no toUpperCase, keep exact

  // Only EXACTLY these 3 are allowed:
  if (v === 'Margin') return 'Margin';
  if (v === 'VAT0')   return 'VAT0';
  if (v === 'VAT21')  return 'VAT21';

  return null; // everything else is invalid
}


/**
 * Compute normalized offer based on VAT type.
 * - Margin / VAT21 → use as-is
 * - VAT0 → multiply by 1.21 to compare fairly
 */
function getNormalizedOffer(price, vatType) {
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  if (vatType === 'VAT0') {
    return price * 1.21;
  }
  // Margin or VAT21 (or anything else) treated as "gross" already
  return price;
}

/**
 * Build an action row with only the Offer button.
 */
function buildOfferOnlyRow(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('partner_offer')
      .setLabel('Offer')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled)
  );
}

/**
 * Disable all seller-offer messages (in all deal channels) for a given order record ID.
 * Uses the comma-separated "Seller Offer Message ID" field on Orders.
 */
async function disableSellerOfferMessagesForRecord(orderRecordId) {
  // Load order
  const orderRecord = await base(ordersTableName).find(orderRecordId);
  if (!orderRecord) {
    console.warn(`⚠️ Order record not found for disable: ${orderRecordId}`);
    return;
  }

  const messageIdsRaw = orderRecord.get(ORDER_FIELD_SELLER_MSG_IDS);
  if (!messageIdsRaw) {
    console.warn(`⚠️ No ${ORDER_FIELD_SELLER_MSG_IDS} stored on order: ${orderRecordId}`);
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

  // For each deal channel & each message ID, try to fetch and disable buttons
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

/**
 * Get the current lowest normalized offer for a given order.
 * Looks at Seller Offers linked to that order and returns:
 *   { normalized, raw, vatType }
 * or null if no offers exist.
 *
 * If no offers exist, falls back to Final Outsource Buying Price on the order
 * (treated as Margin with normalized = raw).
 */
async function getCurrentLowestForOrder(orderRecordId) {
  if (!orderRecordId) return null;

  const sellerOffersTable = base(sellerOffersTableName);

  // Find all Seller Offers linked to this order
  const offers = await sellerOffersTable.select({
    filterByFormula: `FIND("${orderRecordId}", ARRAYJOIN({Linked Orders}))`
  }).firstPage();

  let best = null;

  for (const rec of offers) {
    const price = parseNumericField(rec.get('Seller Offer'));
    const vatTypeRaw = rec.get('Offer VAT Type');
    const vatTypeNorm = normalizeVatType(vatTypeRaw || '');
    const normalized = getNormalizedOffer(price, vatTypeNorm);

    if (!Number.isFinite(normalized)) continue;

    if (!best || normalized < best.normalized) {
      best = {
        normalized,
        raw: price,
        vatType: vatTypeNorm || null
      };
    }
  }

  // If we found at least one offer, return it
  if (best) return best;

  // Fallback: use Final Outsource Buying Price from the order
  const orderRec = await base(ordersTableName).find(orderRecordId).catch(() => null);
  if (!orderRec) return null;

  const fallbackVal = parseNumericField(orderRec.get(ORDER_FIELD_FINAL_OUTSOURCE));
  if (!Number.isFinite(fallbackVal)) return null;

  return {
    normalized: fallbackVal,
    raw: fallbackVal,
    vatType: 'Margin' // or 'N/A', whatever you prefer
  };
}

/* ---------------- Express HTTP API ---------------- */

const app = express();
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));

app.get('/', (_req, res) =>
  res.type('text/plain').send('Seller Offers Bot OK')
);

app.get('/health', (_req, res) =>
  res.json({ ok: true, ts: new Date().toISOString() })
);

/**
 * POST /partner-offer-deal
 * (and /partner-deal if you want to reuse the same payload)
 *
 * → Offer-only button (no Claim) with simple embed layout.
 */
async function handleOfferDealPost(req, res) {
  try {
    const {
      productName,
      sku,
      size,
      brand,
      startPayout,  // still accepted but not used in embed
      imageUrl,
      dealId,
      recordId   // Order record ID (Unfulfilled Orders Log)
    } = req.body || {};

    if (!productName || !sku || !size || !brand) {
      return res.status(400).json({ error: 'Missing required fields in payload.' });
    }

    // Simple style like your screenshot:
    // 🔺 NEW DEAL (OFFER ONLY)
    // **Product Name**
    // SKU
    // Size
    // Brand
    const lines = [
      productName ? `**${productName}**` : null,
      sku || null,
      size || null,
      brand || null
    ].filter(Boolean);

    const description =
      lines.join('\n') +
      '\n\nClick the button below to offer us your price on this item.';

    const embed = new EmbedBuilder()
      .setTitle('🚨 NEW DEAL (OFFER ONLY) 🚨')
      .setDescription(description)
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

    // Store message IDs on the ORDER record as "Seller Offer Message ID"
    if (recordId) {
      try {
        const fieldsToUpdate = {
          [ORDER_FIELD_SELLER_MSG_IDS]: messageIds.join(',')
        };
        // Optionally track a flag
        if (ORDER_FIELD_BUTTONS_DISABLED) {
          fieldsToUpdate[ORDER_FIELD_BUTTONS_DISABLED] = false;
        }
        await base(ordersTableName).update(recordId, fieldsToUpdate);
      } catch (e) {
        console.error('Failed to update order record with Seller Offer message IDs / reset flag:', e);
      }
    }

    return res.json({ ok: true, messageIds });
  } catch (err) {
    console.error('Error in offer-deal POST:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
}

app.post('/partner-offer-deal', handleOfferDealPost);
// If you also want /partner-deal to behave the same (offer-only), keep this:
app.post('/partner-deal', handleOfferDealPost);

/**
 * POST /seller-offer/disable
 * Body: { recordId } where recordId = Orders table record ID
 */
app.post('/seller-offer/disable', async (req, res) => {
  try {
    const { recordId } = req.body || {};
    if (!recordId) {
      return res.status(400).json({ error: 'Missing recordId.' });
    }

    await disableSellerOfferMessagesForRecord(recordId);

    try {
      const fieldsToUpdate = {};
      if (ORDER_FIELD_BUTTONS_DISABLED) {
        fieldsToUpdate[ORDER_FIELD_BUTTONS_DISABLED] = true;
        await base(ordersTableName).update(recordId, fieldsToUpdate);
      }
    } catch (e) {
      console.error('Failed to set Seller Offer Buttons Disabled = true:', e);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error in /seller-offer/disable:', err);
    return res.status(500).json({ error: 'Internal error.' });
  }
});

/* ---------------- Discord Interaction Logic ---------------- */

client.on(Events.InteractionCreate, async interaction => {
  try {
    /* ---------- BUTTONS ---------- */
    if (interaction.isButton()) {
      if (
        !dealsChannelIds.includes(interaction.channelId) ||
        interaction.customId !== 'partner_offer'
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

      // Try to find the order linked to this message
      let orderRecordIdForModal = null;
      try {
        const records = await base(ordersTableName)
          .select({
            maxRecords: 1,
            filterByFormula: `SEARCH("${messageId}", {${ORDER_FIELD_SELLER_MSG_IDS}})`
          })
          .firstPage();
        orderRecordIdForModal = records[0]?.id || null;
      } catch (e) {
        console.error('Failed to find order by Seller Offer Message ID:', e);
      }

      // Compute current lowest normalized offer (and its raw + VAT type)
      let lowestInfo = null;
      if (orderRecordIdForModal) {
        lowestInfo = await getCurrentLowestForOrder(orderRecordIdForModal);
      }

      // Build Offer modal
      const modal = new ModalBuilder()
        .setCustomId(`partner_offer_modal:${messageId}`)
        .setTitle('Enter Seller ID, VAT Type & Offer');

      const sellerIdInput = new TextInputBuilder()
        .setCustomId('seller_id')
        .setLabel('Seller ID (e.g. 00001)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('00001');

      const vatTypeInput = new TextInputBuilder()
        .setCustomId('vat_type')
        .setLabel('VAT Type (Margin / VAT0 / VAT21)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder('Margin / VAT0 / VAT21');


      let offerPlaceholder;
      if (lowestInfo && typeof lowestInfo.raw === 'number') {
        const vatLabel = lowestInfo.vatType || 'N/A';
        offerPlaceholder = `Current lowest offer: €${lowestInfo.raw.toFixed(2)} (${vatLabel})`;
      } else {
        offerPlaceholder = 'Enter your offer (e.g. 140)';
      }

      const offerInput = new TextInputBuilder()
        .setCustomId('offer_price')
        .setLabel('Your Offer (€)')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder(offerPlaceholder);

      const row1 = new ActionRowBuilder().addComponents(sellerIdInput);
      const row2 = new ActionRowBuilder().addComponents(vatTypeInput);
      const row3 = new ActionRowBuilder().addComponents(offerInput);

      modal.addComponents(row1, row2, row3);

      await interaction.showModal(modal);
      return;
    }

    /* ---------- MODALS ---------- */
    if (interaction.isModalSubmit()) {
      if (
        !dealsChannelIds.includes(interaction.channelId) ||
        !interaction.customId.startsWith('partner_')
      ) {
        return;
      }

      const [prefix, messageId] = interaction.customId.split(':');

      if (prefix !== 'partner_offer_modal') {
        return; // only offer flow exists in this bot
      }

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

      // Our embed description is:
      // **Product Name**
      // SKU
      // Size
      // Brand
      // <blank>
      // Click the button...
      const descLines = embed.description.split('\n').map(l => l.trim()).filter(Boolean);

      const productName = (descLines[0] || '').replace(/\*\*/g, '') || '';
      const sku         = descLines[1] || '';
      const size        = descLines[2] || '';
      const brand       = descLines[3] || '';

      // Find order by Seller Offer Message ID
      let orderRecordId = null;
      try {
        const records = await base(ordersTableName)
          .select({
            maxRecords: 1,
            filterByFormula: `SEARCH("${messageId}", {${ORDER_FIELD_SELLER_MSG_IDS}})`
          })
          .firstPage();
        orderRecordId = records[0]?.id || null;
      } catch (e) {
        console.error('Failed to find order by Seller Offer Message ID (modal submit):', e);
      }

      const sellerNumberRaw = interaction.fields.getTextInputValue('seller_id').trim();

      if (!/^\d+$/.test(sellerNumberRaw)) {
        await interaction.reply({
          content: '❌ Seller Number must contain digits only (no SE-, just the digits). Please try again.',
          ephemeral: true
        });
        return;
      }

      const vatTypeRaw = interaction.fields.getTextInputValue('vat_type').trim();
      const vatType = normalizeVatType(vatTypeRaw);
      if (!vatType) {
        await interaction.reply({
          content: '❌ Invalid VAT Type. Please use one of: Margin, VAT0, VAT21.',
          ephemeral: true
        });
        return;
      }

      const rawOffer = interaction.fields.getTextInputValue('offer_price').trim();
      const offerPrice = parseFloat(rawOffer.replace(',', '.') || '0');
      if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
        await interaction.reply({
          content: '❌ Please enter a valid positive offer amount.',
          ephemeral: true
        });
        return;
      }

      const normalizedOffer = getNormalizedOffer(offerPrice, vatType);
      if (!Number.isFinite(normalizedOffer)) {
        await interaction.reply({
          content: '❌ Could not compute a valid normalized price for this VAT type.',
          ephemeral: true
        });
        return;
      }

      // 🔐 SAFETY: enforce "must be at least MIN_UNDERCUT_STEP lower than Current Lowest Offer"
      let referenceLow = null;
      if (orderRecordId) {
        const lowestInfo = await getCurrentLowestForOrder(orderRecordId);
        if (lowestInfo && typeof lowestInfo.normalized === 'number') {
          referenceLow = lowestInfo.normalized;
        }
      }

      if (referenceLow != null) {
        const maxAllowed = referenceLow - MIN_UNDERCUT_STEP;
        if (!(normalizedOffer <= maxAllowed + 1e-9)) {
          const refStr = `€${referenceLow.toFixed(2)}`;
          const maxStr = `€${maxAllowed.toFixed(2)}`;
          await interaction.reply({
            content:
              `❌ Your offer is too high.\n` +
              `Current lowest normalized offer (incl. VAT logic): **${refStr}**.\n` +
              `Your offer must be at least **€${MIN_UNDERCUT_STEP.toFixed(2)}** lower on that basis (≤ **${maxStr}**).`,
            ephemeral: true
          });
          return;
        }
      }

      const sellerCode = `SE-${sellerNumberRaw}`;
      // If you want to still validate seller exists:
      const sellersTable = base(sellersTableName);
      let sellerRecordId = null;
      try {
        const records = await sellersTable
          .select({
            maxRecords: 1,
            filterByFormula: `{Seller ID} = "${sellerCode}"`
          })
          .firstPage();
        sellerRecordId = records[0]?.id || null;
      } catch (e) {
        console.error('Error looking up seller record:', e);
      }

      if (!sellerRecordId) {
        await interaction.reply({
          content: `❌ Could not find a seller with ID \`${sellerCode}\` in Sellers Database.`,
          ephemeral: true
        });
        return;
      }

      // Create record in Seller Offers table
      const sellerOffersTable = base(sellerOffersTableName);

      const fields = {
        'Seller Offer': offerPrice,
        'Offer VAT Type': vatType,
        'Offer Cost (Normalized)': normalizedOffer,
        'Offer Date': new Date().toISOString().split('T')[0],
        'Seller ID': [sellerRecordId]
      };

      if (orderRecordId) {
        fields['Linked Orders'] = [orderRecordId];
      }

      // Optionally also store product metadata on the offer
      if (productName) fields['Product Name'] = productName;
      if (sku)         fields['SKU']         = sku;
      if (size)        fields['Size']        = size;
      if (brand)       fields['Brand']       = brand;

      await sellerOffersTable.create(fields);

      await interaction.reply({
        content:
          `✅ Offer submitted for **${productName} (${size})**.\n` +
          `Seller: \`${sellerCode}\`\n` +
          `Offer: €${offerPrice.toFixed(2)} (${vatType})`,
        ephemeral: true
      });
      return;
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
      } catch (_) {
        // ignore
      }
    }
  }
});

/* ---------------- Start HTTP server ---------------- */

app.listen(PORT, () => {
  console.log(`🌐 Seller Offers Bot HTTP server running on port ${PORT}`);
});
