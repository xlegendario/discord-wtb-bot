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
  PermissionsBitField,
  MessageFlags
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
  AIRTABLE_MEMBER_WTBS_TABLE,
  AIRTABLE_PARTNERS_TABLE,
  PAYOUT_CATEGORY_ID,
  PROCESS_DEAL_WEBHOOK_URL,
  MEMBER_WTB_CATEGORY_ID,
  KC_PORTAL_BASE_URL,
  KC_PORTAL_SECRET,
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

// ---------------- Brand → channel routing (WTB) ----------------

const WTB_DEFAULT_CHANNEL_ID = process.env.WTB_DEFAULT_CHANNEL_ID || dealsChannelIds[0];
if (!WTB_DEFAULT_CHANNEL_ID) {
  console.error('❌ WTB_DEFAULT_CHANNEL_ID is missing. Set WTB_DEFAULT_CHANNEL_ID or DISCORD_DEALS_CHANNEL_ID.');
  process.exit(1);
}


function safeLower(s) {
  return String(s || '').trim().toLowerCase();
}

function normalizeBrand(brand) {
  const b = safeLower(brand);
  if (!b) return '';
  if (b.includes('jordan')) return 'jordan';
  if (b.includes('nike')) return 'nike';
  if (b.includes('adidas')) return 'adidas';
  if (b.includes('new balance')) return 'new balance';
  if (b.includes('asics')) return 'asics';
  if (b.includes('ugg')) return 'ugg';
  return b;
}

function parseBrandChannelMap() {
  const raw = process.env.WTB_BRAND_CHANNEL_MAP || '';
  if (!raw) return new Map();

  try {
    const obj = JSON.parse(raw);
    const map = new Map();
    for (const [k, v] of Object.entries(obj || {})) {
      if (!k || !v) continue;
      map.set(normalizeBrand(k), String(v).trim());
    }
    return map;
  } catch (e) {
    console.warn('⚠️ WTB_BRAND_CHANNEL_MAP is not valid JSON:', e.message);
    return new Map();
  }
}

const WTB_BRAND_CHANNEL_MAP = parseBrandChannelMap();

function pickWTBChannelId(brand) {
  const key = normalizeBrand(brand);
  return WTB_BRAND_CHANNEL_MAP.get(key) || WTB_DEFAULT_CHANNEL_ID;
}

// Airtable view URL for “See All WTB’s”
const WTB_URL =
  'https://kickzcaviar.com';

const INVITE_URL = 'https://discord.gg/GZY9NBpYUS';

/* ---------------- Airtable ---------------- */

const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);

const sellerOffersTableName = AIRTABLE_SELLER_OFFERS_TABLE || 'Seller Offers';
const sellersTableName = AIRTABLE_SELLERS_TABLE || 'Sellers Database';
const ordersTableName = AIRTABLE_ORDERS_TABLE || 'Unfulfilled Orders Log';
const memberWtbsTableName = AIRTABLE_MEMBER_WTBS_TABLE || 'Member WTBs';
const partnersTableName = AIRTABLE_PARTNERS_TABLE || 'Partnerships';

const ORDER_FIELD_SELLER_MSG_IDS = 'Seller Offer Message ID';
const ORDER_FIELD_BUTTONS_DISABLED = 'Seller Offer Buttons Disabled';
const ORDER_FIELD_CURRENT_LOWEST_OFFER = 'Current Lowest Offer';
const ORDER_FIELD_WTB_CHANNEL_ID = 'WTB Channel ID';

const SELLER_OFFERS_FIELD_LINKED_MEMBER_WTBS = 'Linked Member WTBs';

function normalizeSourceType(sourceType) {
  return sourceType === 'member_wtb' ? 'member_wtb' : 'order';
}

function getSourceConfig(sourceType) {
  const clean = normalizeSourceType(sourceType);

  if (clean === 'member_wtb') {
    return {
      sourceType: 'member_wtb',
      tableName: memberWtbsTableName,
      linkedOfferField: SELLER_OFFERS_FIELD_LINKED_MEMBER_WTBS,
      currentLowestField: 'Current Lowest Offer',
      lowestOfferField: 'Lowest Offer',
      messageIdField: ORDER_FIELD_SELLER_MSG_IDS,
      buttonsDisabledField: ORDER_FIELD_BUTTONS_DISABLED,
      channelIdField: ORDER_FIELD_WTB_CHANNEL_ID
    };
  }

  return {
    sourceType: 'order',
    tableName: ordersTableName,
    linkedOfferField: 'Linked Orders',
    currentLowestField: ORDER_FIELD_CURRENT_LOWEST_OFFER,
    lowestOfferField: null,
    messageIdField: ORDER_FIELD_SELLER_MSG_IDS,
    buttonsDisabledField: ORDER_FIELD_BUTTONS_DISABLED,
    channelIdField: ORDER_FIELD_WTB_CHANNEL_ID
  };
}

function getSourceTable(sourceType) {
  return base(getSourceConfig(sourceType).tableName);
}

const PARTNER_FIELD_WEBHOOK_URL = 'WTB Webhook URL';
const PARTNER_FIELD_ACTIVE = 'Active?';
const PARTNER_FIELD_INVITE_URL = 'Invite URL';
const PARTNER_FIELD_LAST_POST_AT = 'Last Post At';

/* ---------------- Utilities ---------------- */

const MIN_UNDERCUT_STEP = 2.5;

function normalizeVatType(raw) {
  if (!raw) return null;
  if (raw === 'Margin') return 'Margin';
  if (raw === 'VAT0') return 'VAT0';
  if (raw === 'VAT21') return 'VAT21';
  return null;
}

function isVatTypeAllowedForMemberWtbFilter(filter, vatType) {
  const cleanFilter = String(filter || '').trim();

  if (cleanFilter === 'B2B Only') {
    return vatType === 'VAT0' || vatType === 'VAT21';
  }

  if (cleanFilter === 'Margin Only' || cleanFilter === 'Private Only') {
    return vatType === 'Margin';
  }

  return ['Margin', 'VAT0', 'VAT21'].includes(vatType);
}

function getAllowedVatTypesText(filter) {
  const cleanFilter = String(filter || '').trim();

  if (cleanFilter === 'B2B Only') return 'VAT0 or VAT21';
  if (cleanFilter === 'Margin Only' || cleanFilter === 'Private Only') return 'Margin';

  return 'Margin, VAT0 or VAT21';
}

function isMemberWtbAutoAccept(record) {
  return record?.get?.('Auto Accept Seller Offers?') === true;
}

function sanitizeChannelName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90);
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

  const baseStr = `€${Math.floor(lowest.raw)}${displayType ? ` (${displayType})` : ''}`;

  if (lowest.vatType === 'VAT21') {
    const asVat0 = lowest.raw / 1.21;
    return `${baseStr} / €${Math.floor(asVat0)} (VAT0)`;
  }

  if (lowest.vatType === 'VAT0') {
    const asMargin = lowest.raw * 1.21;
    return `${baseStr} / €${Math.floor(asMargin)} (Margin)`;
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

async function getCurrentLowest(sourceType, recordId, excludeOfferRecordId = null) {
  if (!recordId) return null;

  const config = getSourceConfig(sourceType);
  const offers = await base(sellerOffersTableName).select().all();

  let best = null;

  for (const rec of offers) {
    if (excludeOfferRecordId && rec.id === excludeOfferRecordId) continue;

    const links = rec.get(config.linkedOfferField);
    if (!Array.isArray(links)) continue;

    const matches = links.some((l) =>
      typeof l === 'string' ? l === recordId : l?.id === recordId
    );

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

  const record = await getSourceTable(sourceType).find(recordId).catch(() => null);
  if (!record) return null;

  const maxPrice =
    parseNumeric(record.get('Current Lowest Source Price')) ??
    parseNumeric(record.get('Maximum Buying Price')) ??
    parseNumeric(record.get('Max Price'));

  if (!Number.isFinite(maxPrice)) return null;

  return { normalized: maxPrice, raw: maxPrice, vatType: 'Margin' };
}

async function findExistingSellerOffer(sourceType, recordId, sellerRecordId) {
  if (!recordId || !sellerRecordId) return null;

  const config = getSourceConfig(sourceType);
  const offers = await base(sellerOffersTableName).select().all();

  return offers.find((rec) => {
    const linkedRecords = rec.get(config.linkedOfferField);
    const linkedSellers = rec.get('Seller ID');

    const matchesRecord =
      Array.isArray(linkedRecords) &&
      linkedRecords.some((item) =>
        typeof item === 'string' ? item === recordId : item?.id === recordId
      );

    const matchesSeller =
      Array.isArray(linkedSellers) &&
      linkedSellers.some((item) =>
        typeof item === 'string' ? item === sellerRecordId : item?.id === sellerRecordId
      );

    return matchesRecord && matchesSeller;
  }) || null;
}

/* ---------------- Disable messages (your server) ---------------- */

async function disableSellerOfferMessages(recordId, sourceType = 'order') {
  const config = getSourceConfig(sourceType);
  const order = await getSourceTable(sourceType).find(recordId).catch(() => null);
  if (!order) return;

  const rawIds = order.get(ORDER_FIELD_SELLER_MSG_IDS);
  if (!rawIds) {
    await getSourceTable(sourceType).update(recordId, { [ORDER_FIELD_BUTTONS_DISABLED]: true }).catch(() => null);
    return;
  }

  const msgIds = String(rawIds).split(',').map((x) => x.trim()).filter(Boolean);

  // NEW: find the one channel where the WTB message was posted
  const storedChannelId = order.get(ORDER_FIELD_WTB_CHANNEL_ID);
  const targetChannelId = storedChannelId || dealsChannelIds[0];

  const channel = await client.channels.fetch(targetChannelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) {
    console.warn(`⚠️ disableSellerOfferMessages: channel not found: ${targetChannelId}`);
    await getSourceTable(sourceType).update(recordId, { [ORDER_FIELD_BUTTONS_DISABLED]: true }).catch(() => null);
    return;
  }

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

  await getSourceTable(sourceType).update(recordId, { [ORDER_FIELD_BUTTONS_DISABLED]: true }).catch(() => null);
}


/* ---------------- Update "Current Lowest Offer" in your server embeds ---------------- */

async function updateLowestOfferDisplays(orderId) {
  if (!orderId) return;

  const order = await base(ordersTableName).find(orderId).catch(() => null);
  if (!order) return;

  const currentLowestRaw = order.get(ORDER_FIELD_CURRENT_LOWEST_OFFER);
  const currentLowestNumber = parseNumeric(currentLowestRaw);
  
  const currentLowestDisplay = Number.isFinite(currentLowestNumber)
    ? `€${Math.floor(currentLowestNumber)}`
    : 'No offers yet';

  const rawInternalIds = order.get(ORDER_FIELD_SELLER_MSG_IDS);
  if (!rawInternalIds) return;

  const msgIds = String(rawInternalIds)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  // find the one channel where the WTB message was posted
  const storedChannelId = order.get(ORDER_FIELD_WTB_CHANNEL_ID);
  const targetChannelId = storedChannelId || dealsChannelIds[0];

  const channel = await client.channels.fetch(targetChannelId).catch(() => null);
  if (!channel || !channel.isTextBased?.()) {
    console.warn(`⚠️ updateLowestOfferDisplays: channel not found or not text-based: ${targetChannelId}`);
    return;
  }

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


/* ---------------- Helper: get active partners ---------------- */

async function getActivePartners() {
  const records = await base(partnersTableName)
    .select({
      filterByFormula: `AND({${PARTNER_FIELD_ACTIVE}}, {${PARTNER_FIELD_WEBHOOK_URL}} != '')`
    })
    .all();

  return records.map((rec) => ({
    id: rec.id,
    name: rec.get('Name') || rec.id,
    webhookUrl: String(rec.get(PARTNER_FIELD_WEBHOOK_URL) || '').trim(),
    inviteUrl: String(rec.get(PARTNER_FIELD_INVITE_URL) || '').trim(), // ✅ NEW
  })).filter(p => !!p.webhookUrl);
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
    const {
      productName,
      sku,
      size,
      brand,
      imageUrl,
      recordId,
      sourceType = 'order'
    } = req.body || {};
    
    const cleanSourceType = normalizeSourceType(sourceType);
    const config = getSourceConfig(cleanSourceType);

    // Read current lowest from the order (for initial embed)
    let currentLowestDisplay = 'No offers yet';
    if (recordId) {
      const order = await getSourceTable(cleanSourceType).find(recordId).catch(() => null);
      if (order) {
        const rawLowest = order.get(config.currentLowestField);
        if (rawLowest) {
          const rawLowestNumber = parseNumeric(rawLowest);
        
          if (Number.isFinite(rawLowestNumber)) {
            currentLowestDisplay = `€${Math.floor(rawLowestNumber)}`;
          }
        }
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
    
    const targetChannelId = pickWTBChannelId(brand);
    console.log(`📌 WTB create: brand="${brand || ''}" -> channelId=${targetChannelId}`);
    
    const channel = await client.channels.fetch(targetChannelId).catch(() => null);
    if (!channel || !channel.isTextBased?.()) {
      return res.status(404).json({
        error: `WTB channel not found or not text-based: ${targetChannelId}`
      });
    }
    
    console.log(`✅ WTB channel resolved: #${channel.name} (${channel.id})`);

    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`seller_offer:${cleanSourceType}:${recordId}`)
        .setLabel('Offer')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder().setLabel("See All WTB's").setStyle(ButtonStyle.Link).setURL(WTB_URL)
    );
    
    const msg = await channel.send({ embeds: [embed], components: [row] });
    
    messageIds.push(msg.id);
    messageUrls.push(msg.url);

    if (recordId) {
      const updateFields = {
        [config.messageIdField]: messageIds.join(','),
        [config.buttonsDisabledField]: false,
        [config.channelIdField]: targetChannelId
      };
    
      if (messageUrls.length > 0) updateFields['Offer Message URL'] = messageUrls[0];
    
      await getSourceTable(cleanSourceType).update(recordId, updateFields);
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
/* Sends WTB embed into partner servers via webhooks (LINKS IN EMBED TEXT, NO BUTTONS) */

app.post('/partner-wtb', async (req, res) => {
  try {
    const { productName, sku, size, brand, imageUrl, recordId } = req.body || {};

    if (!recordId) return res.status(400).json({ error: 'recordId is required' });

    // Optional: keep this if you want to ensure record exists
    const order = await base(ordersTableName).find(recordId).catch(() => null);
    if (!order) return res.status(404).json({ error: 'Order not found in Airtable' });

    const partners = await getActivePartners();
    if (!partners.length) return res.json({ ok: true, message: 'No active partners found', sent: [] });

    const sentByPartner = [];

    for (const partner of partners) {
      const joinUrl = partner.inviteUrl || INVITE_URL;
    
      const embed = {
        title: '🔥 NEW WTB 🔥',
        color: 0xffed00,
        thumbnail: {
          url: 'https://i.imgur.com/JOFvdG2.png'
        },
        description:
          `**${productName || '-'}**\n` +
          `SKU: ${sku || '-'}\n` +
          `Size: ${size || '-'}\n` +
          `Brand: ${brand || '-'}\n\n` +
          `**Sell Now:** [click here](${joinUrl})`,
        ...(imageUrl ? { image: { url: imageUrl } } : {}),
        footer: {
          text: '© 2026 Kickz Caviar — All rights reserved'
        }
      };
    
      const payload = { embeds: [embed] };
    
      const resp = await fetch(`${partner.webhookUrl}?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch((err) => {
        console.error(`Error sending partner webhook (${partner.name}):`, err);
        return null;
      });
    
      if (!resp || !resp.ok) {
        console.warn(`⚠️ Failed sending WTB to partner ${partner.name} (${partner.id})`);
        continue;
      }
    
      // ✅ Success: store timestamp
      await base(partnersTableName)
        .update(partner.id, { [PARTNER_FIELD_LAST_POST_AT]: new Date().toISOString() })
        .catch(() => null);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('Error in /partner-wtb:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* ---------------- POST /seller-offer/place-from-portal ---------------- */

app.post('/seller-offer/place-from-portal', async (req, res) => {
  try {
    const {
      orderRecordId,
      sellerRecordId,
      offerAmount,
      vatType,
      sourceType = 'order'
    } = req.body || {};
    
    const cleanSourceType = normalizeSourceType(sourceType);
    const config = getSourceConfig(cleanSourceType);

    if (!orderRecordId) {
      return res.status(400).json({ error: 'Missing orderRecordId' });
    }

    if (!sellerRecordId) {
      return res.status(400).json({ error: 'Missing sellerRecordId' });
    }

    const normalizedVatType = normalizeVatType(String(vatType || '').trim());

    if (!normalizedVatType) {
      return res.status(400).json({
        error: 'VAT Type must be one of: Margin, VAT0, VAT21.'
      });
    }

    const offerPrice = parseNumeric(offerAmount);

    if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
      return res.status(400).json({
        error: 'Invalid offer amount.'
      });
    }

    const orderRecord = await getSourceTable(cleanSourceType).find(orderRecordId).catch(() => null);

    if (!orderRecord) {
      return res.status(404).json({
        error: 'Order not found.'
      });
    }

    if (cleanSourceType === 'member_wtb') {
      const buyingFilter = String(orderRecord.get('Buying Inventory Filter') || '').trim();
    
      if (!isVatTypeAllowedForMemberWtbFilter(buyingFilter, normalizedVatType)) {
        return res.status(400).json({
          error: `This buyer does not accept ${normalizedVatType} offers for this WTB.`,
          details: `Allowed VAT type: ${getAllowedVatTypesText(buyingFilter)}.`
        });
      }
    }

    const sellerRecord = await base(sellersTableName).find(sellerRecordId).catch(() => null);

    if (!sellerRecord) {
      return res.status(404).json({
        error: 'Seller not found.'
      });
    }

    const fulfillmentStatus = String(orderRecord.get('Fulfillment Status') || '').trim();

    if (cleanSourceType === 'order' && fulfillmentStatus !== 'Outsource') {
      return res.status(409).json({
        error: 'This order is no longer open for offers.'
      });
    }
    
    if (cleanSourceType === 'member_wtb' && ['Allocated', 'Fulfilled', 'Cancelled'].includes(fulfillmentStatus)) {
      return res.status(409).json({
        error: 'This WTB is no longer open for offers.'
      });
    }

    const normalizedOffer = getNormalized(offerPrice, normalizedVatType);

    if (!Number.isFinite(normalizedOffer)) {
      return res.status(400).json({
        error: 'Could not normalize offer amount.'
      });
    }

    const existingOffer = await findExistingSellerOffer(cleanSourceType, orderRecord.id, sellerRecord.id);
    const lowest = await getCurrentLowest(cleanSourceType, orderRecordId, existingOffer?.id || null);

    if (lowest) {
      const maxAllowedGross = lowest.normalized - MIN_UNDERCUT_STEP;

      if (normalizedOffer > maxAllowedGross + 1e-9) {
        let maxForSeller = maxAllowedGross;

        if (normalizedVatType === 'VAT0') {
          maxForSeller = maxAllowedGross / 1.21;
        }

        const maxForSellerRounded = Math.floor(maxForSeller);

        return res.status(400).json({
          error: 'Offer is too high.',
          details:
            `Offers must undercut the current lowest offer by at least €2.50.\n` +
            `Max allowed offer: €${maxForSellerRounded} (${normalizedVatType}).`
        });
      }
    }

    const fields = {
      'Seller Offer': offerPrice,
      'Offer VAT Type': normalizedVatType,
      'Offer Cost (Normalized)': normalizedOffer,
      'Offer Date': new Date().toISOString().split('T')[0],
      'Seller ID': [sellerRecord.id],
      [config.linkedOfferField]: [orderRecord.id]
    };

    let savedOffer;

    if (existingOffer) {
      savedOffer = await base(sellerOffersTableName).update(existingOffer.id, fields);
    } else {
      savedOffer = await base(sellerOffersTableName).create(fields);
    }
    
    return res.json({
      ok: true,
      action: existingOffer ? 'updated' : 'created',
      offerRecordId: savedOffer.id,
      offerAmount: offerPrice,
      vatType: normalizedVatType,
      normalizedOffer
    });
  } catch (err) {
    console.error('Portal offer submit failed:', err);

    return res.status(500).json({
      error: 'Offer submit failed.',
      details: err.message
    });
  }
});

/* ---------------- POST /seller-offer/disable ---------------- */

app.post('/seller-offer/disable', async (req, res) => {
  const {
    recordId,
    sourceType = 'order'
  } = req.body || {};

  if (!recordId) {
    return res.status(400).json({ error: 'Missing recordId' });
  }

  await disableSellerOfferMessages(recordId, sourceType);

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

async function createMemberWtbDealChannel({
  memberWtbRecord,
  sellerRecord,
  sellerOfferRecordId,
  sellerCode,
  discordUserId,
  offerPrice,
  vatType,
  imageUrl
}) {
  if (!MEMBER_WTB_CATEGORY_ID) {
    throw new Error('MEMBER_WTB_CATEGORY_ID is missing');
  }

  const category = await client.channels.fetch(MEMBER_WTB_CATEGORY_ID).catch(() => null);

  if (!category || !category.guild) {
    throw new Error('Invalid MEMBER_WTB_CATEGORY_ID');
  }

  const guild = category.guild;

  await guild.members.fetch(discordUserId).catch(() => null);

  const memberWtbId =
    memberWtbRecord.get('Member WTB ID') ||
    memberWtbRecord.get('WTB ID') ||
    memberWtbRecord.id;

  const channelName = sanitizeChannelName(`${memberWtbId}`);

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
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.AttachFiles,
          PermissionsBitField.Flags.EmbedLinks
        ]
      }
    ]
  });

  const payoutNum = Number(offerPrice);

  const embed = new EmbedBuilder()
    .setTitle('✅ Member WTB Deal Reserved')
    .setDescription(
      `**Member WTB:** ${memberWtbId}\n` +
      `**Product:** ${memberWtbRecord.get('Product Name') || '-'}\n` +
      `**SKU:** ${memberWtbRecord.get('SKU') || '-'}\n` +
      `**Size:** ${memberWtbRecord.get('Size') || '-'}\n` +
      `**Brand:** ${memberWtbRecord.get('Brand') || '-'}\n` +
      `**Payout:** €${Number.isFinite(payoutNum) ? payoutNum.toFixed(2) : '0.00'}\n` +
      `**VAT Type:** ${vatType || '-'}\n` +
      `**Seller:** ${sellerCode}`
    )
    .setColor(0xf1c40f);

  if (imageUrl) embed.setImage(imageUrl);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`process_member_wtb:${memberWtbRecord.id}:${sellerOfferRecordId}`)
      .setLabel('Process Deal')
      .setStyle(ButtonStyle.Primary)
  );

  const msg = await channel.send({
    content: `<@${discordUserId}>`,
    embeds: [embed],
    components: [row]
  });

  return {
    channelId: channel.id,
    messageId: msg.id
  };
}

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    /* ---- PROCESS DEAL BUTTON ---- */
    if (interaction.isButton() && interaction.customId.startsWith('process_member_wtb:')) {
      await interaction.deferUpdate().catch(() => null);
    
      try {
        const [, memberWtbRecordId, sellerOfferRecordId] = interaction.customId.split(':');
    
        if (!KC_PORTAL_BASE_URL || !KC_PORTAL_SECRET) {
          throw new Error('KC_PORTAL_BASE_URL or KC_PORTAL_SECRET is missing');
        }
    
        const response = await fetch(`${KC_PORTAL_BASE_URL}/api/member-wtb/process-seller-offer`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-kc-secret': KC_PORTAL_SECRET
          },
          body: JSON.stringify({
            member_wtb_record_id: memberWtbRecordId,
            seller_offer_record_id: sellerOfferRecordId,
            discord_channel_id: interaction.channelId,
            discord_message_id: interaction.message.id
          })
        });
    
        const data = await response.json().catch(() => ({}));
    
        if (!response.ok) {
          throw new Error(data.details || data.error || 'Failed to process Member WTB deal');
        }
    
        const disabledComponents = interaction.message.components.map((row) =>
          new ActionRowBuilder().addComponents(
            ...row.components.map((comp) => ButtonBuilder.from(comp).setDisabled(true))
          )
        );
    
        await interaction.message.edit({ components: disabledComponents }).catch(() => null);
    
        const paymentStatus = data?.payment_gate?.status;

        await interaction.channel?.send({
          content:
            paymentStatus === "trusted"
              ? "✅ Deal processed."
              : "✅ Deal processed. Waiting for buyer to make the payment."
        });
    
        return;
      } catch (err) {
        console.error('process_member_wtb failed:', err);
    
        await interaction.followUp({
          content: `❌ ${err.message}`,
          flags: MessageFlags.Ephemeral
        }).catch(() => null);
    
        return;
      }
    }
    
    if (interaction.isButton() && interaction.customId.startsWith('process_payout:')) {
      const [, orderId, sellerCode, discordUserId] = interaction.customId.split(':');

      const embed = interaction.message.embeds?.[0];
      if (!embed || !embed.description) {
        return interaction.reply({ content: '❌ Missing deal details on this message.', flags: MessageFlags.Ephemeral })
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
      
      const readyEmbed = new EmbedBuilder()
        .setTitle('📦 Ready to Ship')
        .setColor(0x2ecc71)
        .addFields(
          {
            name: '💶 Payout',
            value: payoutLine,
            inline: false
          },
          {
            name: '📦 Next Step',
            value: 'Click **Request Label** when you are ready to ship.',
            inline: false
          },
          {
            name: '📬 Packaging Instructions',
            value:
              'Use a clean, unbranded box.\nRemove all price tags.\nNo extra items inside.',
            inline: false
          }
        )
        .setFooter({ text: 'Kickz Caviar' });

      const requestLabelRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`request_label_wtb:${orderId}`)
          .setLabel('Request Label')
          .setStyle(ButtonStyle.Primary)
      );
      
      await interaction.channel?.send({
        content: `<@${discordUserId}>`,
        embeds: [readyEmbed],
        components: [requestLabelRow]
      });

      return interaction.reply({ content: '✅ Deal processed and instructions sent in this channel.', flags: MessageFlags.Ephemeral })
    }

    if (interaction.isButton() && interaction.customId.startsWith('request_label_wtb:')) {
      const orderId = interaction.customId.split(':')[1];
    
      try {
        // 👇 VERY IMPORTANT: acknowledge fast (prevents double click errors)
        await interaction.deferUpdate();
    
        const existingRows = interaction.message.components || [];

        const newRows = existingRows.map((row) =>
          new ActionRowBuilder().addComponents(
            ...row.components.map((btn) => {
              if (btn.customId?.startsWith('request_label_wtb:')) {
                return ButtonBuilder.from(btn)
                  .setDisabled(true)
                  .setLabel('Label Requested')
                  .setStyle(ButtonStyle.Secondary);
              }
              return btn;
            })
          )
        );
        
        await interaction.message.edit({
          components: newRows
        });
    
        // 👇 find Airtable record
        const records = await base(ordersTableName)
          .select({
            filterByFormula: `{Order ID} = "${orderId}"`,
            maxRecords: 1
          })
          .firstPage();
    
        // 👇 find Airtable record
        const record = records[0];
        if (!record) throw new Error(`Order ${orderId} not found`);
        
        // 👇 ADD THIS BLOCK HERE
        if (!process.env.LOJIQ_WMS_BASE_URL) {
          throw new Error('LOJIQ_WMS_BASE_URL is missing');
        }
        
        // 👇 call WMS
        const response = await fetch(`${process.env.LOJIQ_WMS_BASE_URL}/api/request-label`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source: 'wtb_deal',
            record_id: record.id
          })
        });
    
        const data = await response.json().catch(() => ({}));
    
        if (!response.ok) {
          throw new Error(data.details || data.error || 'Failed to request label');
        }
    
        // 👇 confirmation message (THIS FIXES YOUR ISSUE)
        await interaction.followUp({
          content: `✅ Label request received. We’ll process it shortly.`,
          flags: MessageFlags.Ephemeral
        });
    
      } catch (err) {
        console.error('WTB label request failed:', err);
    
        await interaction.followUp({
          content: `❌ ${err.message}`,
          flags: MessageFlags.Ephemeral
        }).catch(() => null);
      }
    
      return;
    }

    /* ---- OFFER BUTTON ---- */
    if (
      interaction.isButton() &&
      (
        interaction.customId === 'seller_offer' ||
        interaction.customId.startsWith('seller_offer:')
      )
    ) {
      const messageId = interaction.message.id;
    
      let sourceType = 'order';
      let sourceRecordId = null;
    
      if (interaction.customId.startsWith('seller_offer:')) {
        const parts = interaction.customId.split(':');
        sourceType = normalizeSourceType(parts[1]);
        sourceRecordId = parts[2] || null;
      }

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
        .setCustomId(`seller_offer_modal:${sourceType}:${sourceRecordId || ''}:${messageId}`)
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
      // ✅ ACK FAST to prevent 10062
      await interaction.deferReply({ ephemeral: true }).catch(() => null);
    
      try {
        const modalParts = interaction.customId.split(':');

        let sourceType = 'order';
        let orderId = null;
        let messageId = null;
        
        if (modalParts.length >= 4) {
          sourceType = normalizeSourceType(modalParts[1]);
          orderId = modalParts[2] || null;
          messageId = modalParts[3];
        } else {
          messageId = modalParts[1];
        }
    
        let orderRecord = null;

        if (!orderId) {
          try {
            const recs = await base(ordersTableName)
              .select({
                filterByFormula: `SEARCH("${messageId}", {${ORDER_FIELD_SELLER_MSG_IDS}})`,
                maxRecords: 1
              })
              .firstPage();
        
            orderRecord = recs[0] || null;
          } catch (_) {}
        
          orderId = orderRecord?.id || null;
        }
    
        const sellerDigits = interaction.fields.getTextInputValue('seller_id').trim();
        const retryCustomId =
          interaction.guildId && interaction.channelId
            ? `retry_offer:${interaction.guildId}:${interaction.channelId}:${messageId}`
            : null;
    
        if (!/^\d+$/.test(sellerDigits)) {
          const msg = '❌ Seller ID must be digits only.';
          await interaction.editReply({ content: msg }).catch(() => null);
          await safeDMWithRetry(interaction.user, `${msg}\n\nYou can try again by clicking the button below.`, retryCustomId);
          return;
        }
    
        const sellerCode = `SE-${sellerDigits}`;
    
        const vatInput = normalizeVatType(interaction.fields.getTextInputValue('vat_type').trim());
        if (!vatInput) {
          const msg = '❌ VAT Type must be one of: Margin, VAT0, VAT21.';
          await interaction.editReply({ content: msg }).catch(() => null);
          await safeDMWithRetry(interaction.user, `${msg}\n\nYou can try again by clicking the button below.`, retryCustomId);
          return;
        }

        let sourceRecord = null;

        if (orderId) {
          sourceRecord = await getSourceTable(sourceType).find(orderId).catch(() => null);
        }
        
        if (sourceType === 'member_wtb') {
          if (!sourceRecord) {
            await interaction.editReply({ content: '❌ Member WTB not found.' }).catch(() => null);
            return;
          }
        
          const buyingFilter = String(sourceRecord.get('Buying Inventory Filter') || '').trim();
        
          if (!isVatTypeAllowedForMemberWtbFilter(buyingFilter, vatInput)) {
            const msg =
              `❌ This buyer does not accept ${vatInput} offers for this WTB.\n` +
              `Allowed VAT type: **${getAllowedVatTypesText(buyingFilter)}**.`;
        
            await interaction.editReply({ content: msg }).catch(() => null);
            await safeDMWithRetry(interaction.user, `${msg}\n\nYour offer was **not** saved.`, retryCustomId);
            return;
          }
        }
    
        const offerPrice = parseFloat(interaction.fields.getTextInputValue('offer_price').replace(',', '.'));
        if (!Number.isFinite(offerPrice) || offerPrice <= 0) {
          const msg = '❌ Invalid offer price.';
          await interaction.editReply({ content: msg }).catch(() => null);
          await safeDMWithRetry(interaction.user, `${msg}\n\nYou can try again by clicking the button below.`, retryCustomId);
          return;
        }
    
        const normalizedOffer = getNormalized(offerPrice, vatInput);

        // lookup seller before validation so we can prevent duplicate offers
        const sellers = await base(sellersTableName)
          .select({ filterByFormula: `{Seller ID} = "${sellerCode}"`, maxRecords: 1 })
          .firstPage();
        
        const sellerRecordId = sellers[0]?.id;
        
        if (!sellerRecordId) {
          const msg = `❌ Seller ${sellerCode} not found.`;
          await interaction.editReply({ content: msg }).catch(() => null);
          await safeDMWithRetry(interaction.user, `${msg}\n\nPlease check your Seller ID and try again by clicking the button below.`, retryCustomId);
          return;
        }
        
        const existingOffer = orderId
          ? await findExistingSellerOffer(sourceType, orderId, sellerRecordId)
          : null;
    
        // undercut logic
        if (orderId) {
          const lowest = await getCurrentLowest(sourceType, orderId, existingOffer?.id || null);
          if (lowest) {
            const maxAllowedGross = lowest.normalized - MIN_UNDERCUT_STEP;
    
            if (normalizedOffer > maxAllowedGross + 1e-9) {
              const lowestStr = formatLowestForDisplay(lowest);
    
              let maxForSeller = maxAllowedGross;
              if (vatInput === 'VAT0') maxForSeller = maxAllowedGross / 1.21;
    
              const maxForSellerRounded = Math.floor(maxForSeller);

              const maxDisplay = `€${maxForSellerRounded} (${vatInput})`;
              const altDisplay = '';
    
              const msg =
                `❌ Offer too high.\n` +
                `Current lowest: **${lowestStr}**\n` +
                `Your offer must be at least **€${MIN_UNDERCUT_STEP.toFixed(2)}** lower than that.\n` +
                `Max allowed for your VAT type: **${maxDisplay}${altDisplay}**.`;
    
              await interaction.editReply({ content: msg }).catch(() => null);
              await safeDMWithRetry(interaction.user, `${msg}\n\nYour offer was **not** saved. You can try again by clicking the button below.`, retryCustomId);
              return;
            }
          }
        }

        // OPTIONAL: store/refresh Discord ID on the Seller record (editable field!)
        const SELLER_DISCORD_ID_FIELD = 'Discord User ID';

        const existing = sellers[0]?.get?.(SELLER_DISCORD_ID_FIELD) || null;
        if (!existing) {
          await base(sellersTableName)
            .update(sellerRecordId, { [SELLER_DISCORD_ID_FIELD]: interaction.user.id })
            .catch(() => null);
        }

    
        const fields = {
          'Seller Offer': offerPrice,
          'Offer VAT Type': vatInput,
          'Offer Cost (Normalized)': normalizedOffer,
          'Offer Date': new Date().toISOString().split('T')[0],
          'Seller ID': [sellerRecordId]
        };
        
        if (orderId) {
          fields[getSourceConfig(sourceType).linkedOfferField] = [orderId];
        }
        
        let savedOffer;

        if (existingOffer) {
          savedOffer = await base(sellerOffersTableName).update(existingOffer.id, fields);
        } else {
          savedOffer = await base(sellerOffersTableName).create(fields);
        }
        
        if (orderId) {
          const config = getSourceConfig(sourceType);
          const lowestAfterSave = await getCurrentLowest(sourceType, orderId);
        
          if (lowestAfterSave && Number.isFinite(lowestAfterSave.raw)) {
            const updateFields = {
              [config.currentLowestField]: lowestAfterSave.raw
            };
        
            if (config.lowestOfferField) {
              updateFields[config.lowestOfferField] = lowestAfterSave.raw;
            }
        
            await getSourceTable(sourceType).update(orderId, updateFields);
          }
        }

        if (sourceType === 'member_wtb' && sourceRecord && isMemberWtbAutoAccept(sourceRecord)) {
          const result = await createMemberWtbDealChannel({
            memberWtbRecord: sourceRecord,
            sellerRecord: sellers[0],
            sellerOfferRecordId: savedOffer.id,
            sellerCode,
            discordUserId: interaction.user.id,
            offerPrice,
            vatType: vatInput,
            imageUrl: interaction.message.embeds?.[0]?.image?.url || null
          });
        
          await getSourceTable(sourceType).update(orderId, {
            'Purchase Status': 'Processing',
            'WTB Channel ID': result.channelId
          }).catch(() => null);
        
          await disableSellerOfferMessages(orderId, sourceType);
        
          await interaction.editReply({
            content:
              `✅ Your offer has been accepted automatically.\n` +
              `A private deal channel has been created: <#${result.channelId}>`
          }).catch(() => null);
        
          return;
        }

    
        await interaction.editReply({
          content: `✅ Offer ${existingOffer ? 'updated' : 'submitted'}.\nSeller: ${sellerCode}\nOffer: €${Math.floor(offerPrice)} (${vatInput})`
        }).catch(() => null);
    
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
    
        return;
      } catch (err) {
        console.error('seller_offer_modal submit error:', err);
        await interaction.editReply({ content: '❌ Something went wrong. Please try again.' }).catch(() => null);
        return;
      }
    }

    /* ---- RETRY OFFER BUTTON (DM) ---- */
    if (interaction.isButton() && interaction.customId.startsWith('retry_offer:')) {
      const parts = interaction.customId.split(':');
      const messageId = parts[3];

      // Re-open the offer modal with the same placeholder logic
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
  } catch (err) {
    console.error('Interaction error:', err);
  }
});

/* ---------------- Start HTTP server ---------------- */

app.listen(PORT, () => console.log(`🌐 WTB Seller Offers Bot running on port ${PORT}`));
