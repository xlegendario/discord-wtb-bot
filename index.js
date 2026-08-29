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
const counterOffersTableName = 'Counter Offers';
const sellersTableName = AIRTABLE_SELLERS_TABLE || 'Sellers Database';
const ordersTableName = AIRTABLE_ORDERS_TABLE || 'Unfulfilled Orders Log';
const memberWtbsTableName = AIRTABLE_MEMBER_WTBS_TABLE || 'Member WTBs';
const partnersTableName = AIRTABLE_PARTNERS_TABLE || 'Partnerships';

const ORDER_FIELD_SELLER_MSG_IDS = 'Seller Offer Message ID';
const ORDER_FIELD_BUTTONS_DISABLED = 'Seller Offer Buttons Disabled';
const ORDER_FIELD_CURRENT_LOWEST_OFFER = 'Current Lowest Offer';
const ORDER_FIELD_WTB_CHANNEL_ID = 'WTB Channel ID';

const SELLER_OFFERS_FIELD_LINKED_MEMBER_WTBS = 'Member WTBs';

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

// Reads a hand-typed VAT type.
//
// This was an exact, case-sensitive comparison: anyone typing "margin" or
// "vat21" was refused, while what they meant was perfectly clear. Discord
// modals have no dropdown and no input mask, so reading leniently is the only
// way to take those typos out.
function normalizeVatType(raw) {
  const clean = String(raw ?? '').toLowerCase().replace(/[\s._-]/g, '');

  if (!clean) return null;

  if (clean === 'margin' || clean === 'marge' || clean === 'm') return 'Margin';
  if (/^(vat|btw)?21%?$/.test(clean)) return 'VAT21';
  if (/^(vat|btw)?0+%?$/.test(clean)) return 'VAT0';

  return null;
}

// The portal knows which seller belongs to which Discord ID and sends the
// mail for claiming a profile. This bot asks it there instead of requesting a
// Seller ID on every offer.

// Without these two the seller lookup falls back silently to the old route:
// the user still gets the offer form and only hears something is wrong on
// submit. That fallback is deliberate (a portal being down must not block
// everything), but a missing env var should be visible.
if (!KC_PORTAL_SECRET) {
  console.error(
    '❌ KC_PORTAL_SECRET ontbreekt — seller-lookup en profiel claimen werken niet. ' +
      'Zet KC_PORTAL_SECRET en KC_PORTAL_BASE_URL op deze service.'
  );
} else {
  console.log(`✅ Portal-koppeling actief: ${KC_PORTAL_BASE_URL}`);
}

async function portalPost(path, body) {
  if (!KC_PORTAL_BASE_URL || !KC_PORTAL_SECRET) {
    throw new Error('KC_PORTAL_BASE_URL or KC_PORTAL_SECRET is missing');
  }

  const response = await fetch(`${KC_PORTAL_BASE_URL.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-kc-secret': KC_PORTAL_SECRET },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Portal call failed (${response.status})`);
  }

  return data;
}

const SUPPORT_CHANNEL_MENTION = '<#1444838494760603769>';
const PORTAL_SIGNUP_URL = `${String(KC_PORTAL_BASE_URL || 'https://kickzcaviar.com').replace(/\/$/, '')}/signup`;

// What someone had filled in when it turned out their Discord was not linked
// to anything yet. Without this they would start over after claiming, which
// moves the friction rather than removing it. Held in memory: it does not need
// to survive a restart, they simply click again.
const pendingOffers = new Map();

// Discord gives three seconds to answer a button click, and showModal cannot
// be deferred. A short cache keeps the common case - a known seller - at zero
// network traffic.
const sellerLookupCache = new Map();
const SELLER_LOOKUP_TTL_MS = 5 * 60 * 1000;

function forgetSellerLookup(discordId) {
  sellerLookupCache.delete(discordId);
}

// Returns the lookup result, or null if it did not finish in time. On null
// the caller simply continues with the offer modal: the submit handler catches
// it after all, exactly as before.
async function lookupSellerCached(discordId) {
  const cached = sellerLookupCache.get(discordId);

  if (cached && Date.now() - cached.at < SELLER_LOOKUP_TTL_MS) return cached.value;

  try {
    const value = await Promise.race([
      portalPost('/api/internal/seller-by-discord', { discord_id: discordId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
    ]);

    sellerLookupCache.set(discordId, { value, at: Date.now() });
    return value;
  } catch (err) {
    console.error('seller-by-discord lookup failed:', err.message);
    return null;
  }
}


const NOT_LINKED_EMBED = {
  title: '⚠️ We could not find your seller profile',
  description: [
    "This Discord account isn't connected to a seller profile, so we don't know who's making this offer.",
    '',
    "**Sold with us before?** Use *Link my Seller ID* — you'll need your Seller ID and the email on your profile.",
    '',
    '**New here?** Use *Create a profile* to sign up.',
    '',
    'Neither of these? Open a ticket in <#1444838494760603769> and we will sort it out.'
  ].join('\n'),
  // The same yellow as the rest of the onboarding messages.
  color: 0xffd300
};

function notLinkedComponents() {
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Link my Seller ID', custom_id: 'claim_start' },
        { type: 2, style: 5, label: 'Create a profile', url: PORTAL_SIGNUP_URL }
      ]
    }
  ];
}

async function dmNotLinked(user) {
  try {
    await user.send({ embeds: [NOT_LINKED_EMBED], components: notLinkedComponents() });
  } catch (err) {
    // Blocked DMs are not an error; the ephemeral reply still lands.
    console.warn('Could not DM not-linked notice:', err.message);
  }
}

function buildClaimProfileModal() {
  const modal = new ModalBuilder()
    .setCustomId('claim_profile_modal')
    .setTitle('Link your Seller ID');

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('claim_seller_id')
        .setLabel('Your Seller ID (numbers only)')
        .setPlaceholder('00001')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('claim_email')
        .setLabel('The email on your seller profile')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
    )
  );

  return modal;
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

// Validates a seller's chosen VAT type against their Sellers Database
// profile (VAT ID + Country). Returns null when allowed, or the exact
// block message when not. Rules: no VAT ID → Margin only; VAT ID + NL →
// no VAT0; VAT ID + non-NL → no VAT21. Margin always allowed. Mirrors
// validateSellerVatEligibility in the kickz-caviar portal so both the
// Discord and Portal offer-placement paths enforce identical rules.
function validateSellerVatEligibility(sellerVatId, sellerCountry, chosenVatType) {
  const vat = String(chosenVatType || '').trim();
  if (vat === 'Margin') return null;

  const hasVatId = !!String(sellerVatId || '').trim();
  const country = String(sellerCountry || '').trim().toLowerCase();
  const isNl = country === 'netherlands' || country === 'nederland' || country === 'nl';

  if (!hasVatId) {
    return "You're not a registered company according to your profile. Please select Margin VAT Type or contact support.";
  }
  if (isNl && vat === 'VAT0') {
    return "As a Dutch company, you can't sell VAT0 to Kickz Caviar B.V.. Please select VAT21 or Margin VAT Type or contact support.";
  }
  if (!isNl && vat === 'VAT21') {
    return "As a Non-Dutch company, you can't sell VAT21 to Kickz Caviar B.V.. Please select VAT0 or Margin VAT Type or contact support.";
  }
  return null;
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

// NEW — additive only: Airtable lookup fields arrive as arrays
// (["0.22"]), and parseNumeric only understands numbers and strings, so
// it returns null for them. Needed to read "Client VAT Rate" off an
// Unfulfilled Orders Log record.
function lookupNumber(value) {
  return parseNumeric(Array.isArray(value) ? value[0] : value);
}

// NEW — additive only: which divisor converts a "max allowed offer"
// down to the VAT0 scale a seller types in.
//
// getCurrentLowest can return a figure from two completely different
// scales, and they need different divisors:
//
//   basis 'offers'            — another seller's live position. That is
//                               already a SELLER-side number on the
//                               Dutch all-in scale, so 1.21. Unchanged.
//   basis 'member_wtb_max'    — a Member WTB's Max Price. Buyer side,
//                               Dutch VAT, so 1.21. Unchanged.
//   basis 'max_buying_price'  — the STORE's "Maximum Buying Price",
//                               which is all-in in the CLIENT's own VAT
//                               scale (Italy 22%, Denmark 25%). Using
//                               1.21 here mixed the Dutch rate into a
//                               foreign store's number and handed the
//                               first seller on an untouched order a
//                               ceiling that was several euro too high.
//
// Falls back to 1.21 whenever the rate is missing, so behaviour is
// unchanged for anything that does not carry one.
function vat0CeilingDivisor(lowest) {
  const rate = lowest?.clientVatRate;
  if (lowest?.basis === 'max_buying_price' && Number.isFinite(rate) && rate > 0) {
    return 1 + rate;
  }
  return 1.21;
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

  // NEW — additive only: his explicit request — a fresh offer must
  // also beat any OTHER seller's live counter position, not just their
  // raw, possibly-stale Seller Offer (their raw offer never changes
  // once they start negotiating — the Counter Offers table is where
  // their actual current position lives). Sellers who currently have
  // an open counter round get excluded from the raw-offer pass below
  // and use their live counter price here instead.
  const isMemberWtb = normalizeSourceType(sourceType) === 'member_wtb';
  const counterSourceType = isMemberWtb ? 'Member WTB' : 'Seller Offer';
  const counterLinkField = isMemberWtb ? 'Member WTB' : 'Order';

  let activeCounters = [];
  try {
    activeCounters = await base(counterOffersTableName)
      .select({
        filterByFormula: `AND({Status} = 'Open', {Source Type} = '${counterSourceType}')`
      })
      .all();
  } catch (err) {
    console.error('Failed to fetch active counters for cross-seller lowest check (non-blocking):', err);
  }

  const sellerIdsWithActiveCounter = new Set();
  let best = null;

  for (const cr of activeCounters) {
    const links = cr.get(counterLinkField);
    const linkedId = Array.isArray(links) ? links[0] : links;
    const matchId = typeof linkedId === 'string' ? linkedId : linkedId?.id;
    if (matchId !== recordId) continue;

    const sellerLinks = cr.get('Seller ID');
    const sellerLinkId = Array.isArray(sellerLinks) ? sellerLinks[0] : sellerLinks;
    const sellerId = typeof sellerLinkId === 'string' ? sellerLinkId : sellerLinkId?.id;
    if (sellerId) sellerIdsWithActiveCounter.add(sellerId);

    const sellerCounterPrice = parseNumeric(cr.get('Seller Counter Price'));
    const sellerOriginalPrice = parseNumeric(cr.get('Seller Original Price'));
    const effectivePrice = sellerCounterPrice || sellerOriginalPrice;
    const vatRaw = cr.get('Seller Original VAT Type');
    const vat = typeof vatRaw === 'string' ? vatRaw : vatRaw?.name;
    const vatNorm = normalizeVatType(vat);

    if (!effectivePrice) continue;

    const normalized = getNormalized(effectivePrice, vatNorm);
    if (!Number.isFinite(normalized)) continue;

    if (!best || normalized < best.normalized) {
      best = { normalized, raw: effectivePrice, vatType: vatNorm };
    }
  }

  for (const rec of offers) {
    if (excludeOfferRecordId && rec.id === excludeOfferRecordId) continue;

    const links = rec.get(config.linkedOfferField);
    if (!Array.isArray(links)) continue;

    const matches = links.some((l) =>
      typeof l === 'string' ? l === recordId : l?.id === recordId
    );

    if (!matches) continue;

    // Skip — this seller has an active counter round, already
    // accounted for above using their live position instead.
    const sellerLinks = rec.get('Seller ID');
    const sellerLinkId = Array.isArray(sellerLinks) ? sellerLinks[0] : sellerLinks;
    const sellerId = typeof sellerLinkId === 'string' ? sellerLinkId : sellerLinkId?.id;
    if (sellerId && sellerIdsWithActiveCounter.has(sellerId)) continue;

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

  // NEW — additive only: tag which scale this figure is in, so callers
  // can pick the right VAT0 divisor (see vat0CeilingDivisor). This path
  // is a real seller position, i.e. already seller-side.
  //
  // CHANGED - this used to `return best` right here, so as soon as ONE
  // offer existed the buyer's own maximum was never read again. A
  // consignment auto-offer above that maximum then became the ceiling and
  // RAISED the bar instead of lowering it.
  //
  // Live case (24-08-2026, ORD-022267): a held consignment offer of EUR 125
  // VAT21 sat on an order whose Maximum Buying Price was EUR 77,50. The
  // ceiling became 125 - 2,50 = 122,50 and a seller was allowed to bid
  // EUR 90 - well above anything that store would ever pay.
  //
  // The ceiling is the LOWER of the two: nobody may be told they can bid
  // above what the buyer will pay, whatever else is on the record. Both
  // numbers were already available here; the function just stopped early.
  const bestFromOffers = best ? { ...best, basis: 'offers' } : null;

  const record = await getSourceTable(sourceType).find(recordId).catch(() => null);
  if (!record) return bestFromOffers;

  const maxPrice =
    parseNumeric(record.get('Current Lowest Source Price')) ??
    parseNumeric(record.get('Maximum Buying Price')) ??
    parseNumeric(record.get('Max Price'));

  // No maximum on the record: fall back to whatever the offers say. This is
  // the one case where an offer alone still decides the ceiling.
  if (!Number.isFinite(maxPrice)) return bestFromOffers;

  if (normalizeSourceType(sourceType) === 'member_wtb') {
    // FIXED — `?? 10` only catches null/undefined, so a configured
    // "Offer Margin" of 0 was taken literally here while Airtable's
    // IF({Offer Margin}, {Offer Margin}, 10) falls back to 10 — the two
    // then disagreed about the max allowed seller offer. Mirrors
    // getMemberWtbMargin() in kickz-caviar-portal-main exactly: the
    // field wins unless it is blank, non-numeric, or 0.
    const configuredMargin = parseNumeric(record.get('Offer Margin'));
    const offerMargin = Number.isFinite(configuredMargin) && configuredMargin !== 0
      ? configuredMargin
      : CONSIGNMENT_MARKUP;
    const maxSellerOffer = Math.max(0, maxPrice - offerMargin);

    return lowestCeiling(bestFromOffers, {
      normalized: maxSellerOffer,
      raw: maxSellerOffer,
      vatType: 'Margin',
      // Member WTBs have no client — the buyer side is Dutch VAT, so the
      // VAT0 divisor stays 1.21.
      basis: 'member_wtb_max'
    });
  }

  // Store order, no offers yet: this figure is "Maximum Buying Price",
  // which is all-in in the CLIENT's own VAT scale — not the Dutch one.
  // Carry the client rate so the ceiling can be converted correctly.
  return lowestCeiling(bestFromOffers, {
    normalized: maxPrice,
    raw: maxPrice,
    vatType: 'Margin',
    basis: 'max_buying_price',
    clientVatRate: lookupNumber(record.get('Client VAT Rate'))
  });
}

// The ceiling is whichever of the two is lower. Returning the whole object
// rather than just the number keeps the basis and the client rate attached,
// because vat0CeilingDivisor and the error message both need to know WHICH
// ceiling won - a store maximum and a seller position live on different VAT
// scales.
// What we add on top of a consignor's asking price, in euros.
//
// Set CONSIGNMENT_MARKUP to change it; leave it unset and it stays 10,
// which is what every one of these places had hard-coded before.
//
// Changing it only affects NEW deals. A Member WTB writes its margin into
// "Offer Margin" when it is created, and that snapshot keeps leading for
// negotiations already running - so a change never moves the goalposts on
// a consignor mid-conversation.
const CONSIGNMENT_MARKUP = (() => {
  const configured = Number(process.env.CONSIGNMENT_MARKUP);
  return Number.isFinite(configured) && configured > 0 ? configured : 10;
})();

console.log(`\u{1f4b6} Consignment markup: \u20ac${CONSIGNMENT_MARKUP}`);

function lowestCeiling(fromOffers, fromMaximum) {
  if (!fromOffers) return fromMaximum;
  if (!fromMaximum) return fromOffers;

  return fromOffers.normalized <= fromMaximum.normalized
    ? fromOffers
    : fromMaximum;
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

    // Block based on the seller's own registration profile (VAT ID +
    // Country), independent of the WTB's buyer filter above: a private
    // seller (no VAT ID) can only sell Margin; a Dutch company can't
    // sell VAT0; a non-Dutch company can't sell VAT21.
    const sellerVatEligibilityError = validateSellerVatEligibility(
      sellerRecord.get('VAT ID'),
      sellerRecord.get('Country'),
      normalizedVatType
    );
    if (sellerVatEligibilityError) {
      return res.status(400).json({ error: sellerVatEligibilityError });
    }

    const fulfillmentStatus = String(orderRecord.get('Fulfillment Status') || '').trim();

    if (cleanSourceType === 'order' && fulfillmentStatus !== 'Outsource') {
      return res.status(409).json({
        error: 'This order is no longer open for offers.'
      });
    }
    
    if (cleanSourceType === 'member_wtb' && ['Confirmed', 'Allocated', 'Fulfilled', 'Cancelled'].includes(fulfillmentStatus)) {
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

    // FIXED — this always excluded the found "existing offer" from the
    // undercut comparison, which is correct for a genuine edit (you
    // shouldn't have to beat your own current live offer) but wrong
    // here: findExistingSellerOffer has no status filter, so it also
    // matches a withdrawn/denied record — excluding IT from the
    // comparison meant a fresh re-offer at the exact same, already-
    // denied price went through with no validation at all. Only
    // exclude when the found record is a genuinely active offer, not
    // one that was withdrawn or denied.
    const existingOfferIsWithdrawnOrDenied =
      !!existingOffer?.get('Withdrawn?') || !!existingOffer?.get('Denied?');
    const excludeOfferRecordId = existingOfferIsWithdrawnOrDenied ? null : (existingOffer?.id || null);

    const lowest = await getCurrentLowest(cleanSourceType, orderRecordId, excludeOfferRecordId);

    if (lowest) {
      const isFirstMemberWtbOffer =
        cleanSourceType === "member_wtb" &&
        !existingOffer &&
        parseNumeric(orderRecord.get("Current Lowest Offer")) === null &&
        parseNumeric(orderRecord.get("Lowest Offer")) === null;
    
      const maxAllowedGross = isFirstMemberWtbOffer
        ? lowest.normalized
        : lowest.normalized - MIN_UNDERCUT_STEP;

      // NEW - which ceiling applied is nowhere on the record afterwards, so
      // a question like "how was this 90 ever accepted?" took half an hour of
      // reading code and still ended in a guess. One line makes it a lookup.
      console.log(
        `⚖️ Ceiling for ${cleanSourceType} ${orderRecordId}: ` +
        `${maxAllowedGross.toFixed(2)} (basis ${lowest.basis}, raw ${lowest.normalized}) ` +
        `vs offer ${normalizedOffer.toFixed(2)}`
      );

      if (normalizedOffer > maxAllowedGross + 1e-9) {
        let maxForSeller = maxAllowedGross;

        if (normalizedVatType === 'VAT0') {
          // FIXED — was a hardcoded 1.21. When there are no offers yet,
          // maxAllowedGross comes from the store's "Maximum Buying
          // Price", which is all-in in the CLIENT's VAT scale. See
          // vat0CeilingDivisor. An offer-derived ceiling still uses 1.21.
          maxForSeller = maxAllowedGross / vat0CeilingDivisor(lowest);
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
      'Offer Date': new Date().toISOString(),
      'Seller ID': [sellerRecord.id],
      [config.linkedOfferField]: [orderRecord.id],
      // NEW — additive only: findExistingSellerOffer above can match a
      // previously-withdrawn record (soft-deleted via the Portal's
      // Delete button) and UPDATE it here rather than creating a new
      // one — without this, "Withdrawn?" would stay true forever,
      // leaving a fresh, validated, genuinely active offer invisible
      // in the Portal even though it correctly went through. Also
      // clears "Denied?", since a fresh submission is no longer the
      // thing that was denied.
      'Withdrawn?': false,
      'Denied?': false
    };

    let savedOffer;

    if (existingOffer) {
      savedOffer = await base(sellerOffersTableName).update(existingOffer.id, fields);
    } else {
      savedOffer = await base(sellerOffersTableName).create(fields);
    }

    if (cleanSourceType === "member_wtb") {
      const lowestAfterSave = await getCurrentLowest(cleanSourceType, orderRecordId);
    
      if (lowestAfterSave && Number.isFinite(lowestAfterSave.raw)) {
        await getSourceTable(cleanSourceType).update(orderRecordId, {
          "Current Lowest Offer": lowestAfterSave.raw,
          "Current Lowest Normalized": lowestAfterSave.normalized,
          "Current Lowest Seller Offer": [savedOffer.id],
    
          "New Offer Available": false,
          "Offer Sent?": true,
    
          "Lowest Offer": lowestAfterSave.raw,
          "Lowest Offer Normalized": lowestAfterSave.normalized,
          "Lowest Offer VAT Type": lowestAfterSave.vatType,
          "Lowest Offer Seller ID": [sellerRecord.id]
        });
    
        if (
          !isMemberWtbAutoAccept(orderRecord) &&
          KC_PORTAL_BASE_URL &&
          KC_PORTAL_SECRET
        ) {
          await fetch(`${KC_PORTAL_BASE_URL}/api/member-wtb/send-current-offer-to-buyer`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-kc-secret": KC_PORTAL_SECRET
            },
            body: JSON.stringify({
              member_wtb_record_id: orderRecordId
            })
          }).catch((err) => {
            console.error("Failed to send current offer to buyer:", err);
          });
        }
      }
    }
    
    return res.json({
      ok: true,
      action: existingOffer ? 'updated' : 'created',
      offerRecordId: savedOffer.id,
      offerAmount: offerPrice,
      vatType: normalizedVatType,
      normalizedOffer,
      sourceType: cleanSourceType
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

/* ---------------- POST member-wtb/deal-channel ---------------- */

app.post('/member-wtb/deal-channel', async (req, res) => {
  try {
    const secret = String(req.headers['x-kc-secret'] || '').trim();

    if (!KC_PORTAL_SECRET || secret !== KC_PORTAL_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const memberWtbRecordId = String(req.body?.member_wtb_record_id || '').trim();
    const sellerOfferRecordId = String(req.body?.seller_offer_record_id || '').trim();

    if (!memberWtbRecordId || !sellerOfferRecordId) {
      return res.status(400).json({ error: 'Missing member_wtb_record_id or seller_offer_record_id' });
    }

    const memberWtbRecord = await base(memberWtbsTableName).find(memberWtbRecordId);
    const sellerOfferRecord = await base(sellerOffersTableName).find(sellerOfferRecordId);

    if (String(memberWtbRecord.get('Fulfillment Status') || '').trim() === 'Allocated') {
      return res.status(409).json({ error: 'Member WTB already allocated' });
    }

    const linkedWtbs = sellerOfferRecord.get(SELLER_OFFERS_FIELD_LINKED_MEMBER_WTBS) || [];
    const isLinked = linkedWtbs.some((item) =>
      typeof item === 'string' ? item === memberWtbRecordId : item?.id === memberWtbRecordId
    );

    if (!isLinked) {
      return res.status(400).json({ error: 'Seller Offer is not linked to this Member WTB' });
    }

    const sellerRecordId = Array.isArray(sellerOfferRecord.get('Seller ID'))
      ? sellerOfferRecord.get('Seller ID')[0]
      : '';

    if (!sellerRecordId) {
      return res.status(400).json({ error: 'Seller Offer missing Seller ID' });
    }

    const sellerRecord = await base(sellersTableName).find(sellerRecordId);

    const sellerCode = sellerRecord.get('Seller ID') || sellerRecordId;
    const discordUserId = sellerRecord.get('Discord ID');

    if (!discordUserId) {
      return res.status(400).json({ error: 'Seller missing Discord User ID' });
    }

    // NEW — additive only: optional override for the price/VAT type
    // used to create the deal. Needed for the counter-offer flow, where
    // the agreed price is the negotiated counter amount, not whatever
    // is currently stored on the Seller Offer record — and that record
    // can be linked to more than one Member WTB (see
    // SELLER_OFFERS_FIELD_LINKED_MEMBER_WTBS above), so overwriting its
    // own price field to reflect one specific negotiation isn't safe.
    // Falls back to the exact existing behavior (reading from the
    // Seller Offer record) when not provided, so every existing caller
    // is unaffected.
    const overridePrice = req.body?.override_price != null ? Number(req.body.override_price) : null;
    const overrideVatType = req.body?.override_vat_type ? String(req.body.override_vat_type).trim() : null;

    const offerPrice = Number.isFinite(overridePrice) && overridePrice > 0
      ? overridePrice
      : Number(sellerOfferRecord.get('Seller Offer') || 0);

    // FIXED — precedence was reversed against the portal, which resolves
    // the same thing as `record || override` in process-seller-offer. The
    // PRICE override exists because one Seller Offer can be linked to
    // several Member WTBs, so its stored price need not reflect this
    // negotiation. A VAT type is not like that: it is a property of the
    // offer itself, one value per record, identical for every WTB it
    // touches. An override can therefore only ever equal it or be wrong.
    //
    // Inert today — all 18 writers of "Counter Payout VAT Type" store the
    // seller's own type — but this value is shown to the SELLER as
    // "VAT Type:" in his deal channel and baked into the Process Deal
    // customId below, so a caller passing a buyer-facing label would show
    // him VAT0 while he sells VAT21. The record still falls back to the
    // override when it cannot be read, so no caller loses behaviour.
    const vatType = sellerOfferRecord.get('Offer VAT Type') || overrideVatType || '';

    const picture = memberWtbRecord.get('Picture');
    const imageUrl =
      Array.isArray(picture) && picture[0]?.url
        ? picture[0].url
        : null;

    // NEW - an offer that comes out of consignment stock gets no channel.
    //
    // A consignor already has private channels with us, and a deal on his own
    // stock is finished through the consignment flow: that writes the pair
    // off, and the portal sends his Ready To Ship to his Deal Updates
    // channel. The channel made here would carry a Process Deal button for a
    // deal that is already done, so it arrives dead - exactly what
    // MWTB-000402 and MWTB-000404 (29-08-2026) left behind.
    //
    // The test is the Seller Offer, not the seller. A consignor who offers on
    // something he does NOT hold in consignment stock has no row to write off
    // and no consignment flow to finish it; for him this channel and its
    // Process Deal button are the only way forward, so he still gets one.
    //
    // Decided here rather than at the seven callers in the portal, so the
    // rule cannot drift between them.
    const consignmentInventoryId =
      String(sellerOfferRecord.get('Consignment Inventory ID') || '').trim();

    const result = consignmentInventoryId
      ? null
      : await createMemberWtbDealChannel({
          memberWtbRecord,
          sellerRecord,
          sellerOfferRecordId,
          sellerCode,
          discordUserId,
          offerPrice,
          vatType,
          imageUrl
        });

    if (!result) {
      console.log(
        `⏭️ No deal channel for ${memberWtbRecordId}: seller offer ${sellerOfferRecordId} ` +
          `comes from consignment inventory ${consignmentInventoryId}.`
      );
    }

    await disableSellerOfferMessages(memberWtbRecordId, 'member_wtb');

    await base(memberWtbsTableName).update(memberWtbRecordId, {
      'Fulfillment Status': 'Confirmed'
    });

    return res.json({
      ok: true,
      member_wtb_record_id: memberWtbRecordId,
      seller_offer_record_id: sellerOfferRecordId,
      consignment: Boolean(consignmentInventoryId),
      channel_id: result ? result.channelId : null,
      message_id: result ? result.messageId : null
    });
  } catch (err) {
    console.error('Failed to create Member WTB deal channel:', err);

    return res.status(500).json({
      error: 'Failed to create Member WTB deal channel',
      details: err.message
    });
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
      // FIXED — this button previously only carried the two record
      // IDs, so the "Process Deal" step had no way to know a
      // negotiated counter price/VAT type were ever involved — it
      // would silently fall back to re-reading the Seller Offer
      // record's own (original, non-countered) price. Now carries the
      // exact price/VAT type actually shown in this channel, so the
      // processing step can use them instead of recomputing from
      // scratch.
      .setCustomId(`process_member_wtb:${memberWtbRecord.id}:${sellerOfferRecordId}:${offerPrice}:${vatType || ''}`)
      .setLabel('Process Deal')
      .setStyle(ButtonStyle.Primary)
  );

  const msg = await channel.send({
    content: `<@${discordUserId}>`,
    embeds: [embed],
    components: [row]
  });

  await base(memberWtbsTableName).update(memberWtbRecord.id, {
    "WTB Created Channel ID": channel.id
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
        // FIXED — parse the optional override price/VAT type now
        // carried in the customId (see createMemberWtbDealChannel),
        // and forward them so process-seller-offer uses the actually
        // negotiated amount instead of re-reading the Seller Offer
        // record's original price.
        const [, memberWtbRecordId, sellerOfferRecordId, overridePriceRaw, overrideVatType] =
          interaction.customId.split(':');

        const overridePrice = overridePriceRaw !== undefined && overridePriceRaw !== ''
          ? Number(overridePriceRaw)
          : null;
    
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
            discord_message_id: interaction.message.id,
            override_purchase_price: Number.isFinite(overridePrice) && overridePrice > 0 ? overridePrice : undefined,
            override_vat_type: overrideVatType || undefined
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
    
        // FIXED - this compared against a value the portal never sends.
        //
        // handleMemberWtbPaymentGate returns "trusted_payment_requested",
        // "lojiq_portal_payment", "payment_requested" or "already_processed".
        // Never "trusted". The test was therefore always true, and even a
        // trusted buyer's seller was told to wait for a payment that by
        // definition was never going to hold him up.
        //
        // Three outcomes, three different things to say. "Waiting for
        // payment" is only true for one of them.
        const paymentStatus = data?.payment_gate?.status;

        const waitingCopy = {
          trusted_payment_requested: null,
          already_processed: null,
          // Nothing to say here either. A Lojiq store settles later, in one
          // payment through its own portal, and the deal deliberately does
          // not wait for it - the gate sends the Ready To Ship step right
          // away, same as for a trusted buyer. Adding "waiting for payment"
          // would contradict the button that just arrived.
          lojiq_portal_payment: null,
          payment_requested:
            "✅ Deal confirmed. Waiting for the buyer to pay. You get the " +
            "**Request Label** step here the moment the payment comes in."
        };

        // An unknown status is no reason to say nothing - better a general
        // line than a seller left staring at a dead channel.
        const line = paymentStatus in waitingCopy
          ? waitingCopy[paymentStatus]
          : "✅ Deal processed. Waiting for buyer to make the payment.";

        if (line) {
          await interaction.channel?.send({ content: line });
        }
    
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

      // Double-click guard: disable the buttons IMMEDIATELY, before the
      // slow webhook fetch below, so a second click during the round-trip
      // can't process the deal twice. This edit also serves as the 3s ack.
      const guardDisabledComponents = interaction.message.components.map((row) =>
        new ActionRowBuilder().addComponents(
          ...row.components.map((comp) => ButtonBuilder.from(comp).setDisabled(true))
        )
      );
      try {
        await interaction.update({ components: guardDisabledComponents });
      } catch (guardErr) {
        // If the update fails, the message was likely already acted on
        // (another click won the race) — stop here rather than double-fire.
        return;
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

      return interaction.followUp({ content: '✅ Deal processed and instructions sent in this channel.', flags: MessageFlags.Ephemeral })
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
        }).catch(() => null);
    
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

      // No linked profile yet? Then open the claim modal straight away instead
      // of the offer modal. This has to happen here and not on submit: Discord
      // allows no modal in reply to a modal, so there only an ephemeral message
      // is left - and that appears at the bottom of the channel, where it gets
      // overlooked.
      const sellerCheck = await lookupSellerCached(interaction.user.id);

      if (sellerCheck && !sellerCheck.found) {
        pendingOffers.set(interaction.user.id, {
          retryCustomId: interaction.customId,
          at: Date.now()
        });

        await interaction.reply({
          embeds: [NOT_LINKED_EMBED],
          components: notLinkedComponents(),
          ephemeral: true
        }).catch(() => null);

        await dmNotLinked(interaction.user);
        return;
      }

      let offerPlaceholder = 'Enter your offer (e.g. 140)';
      if (orderRecord) {
        const currentLowestRaw = orderRecord.get(ORDER_FIELD_CURRENT_LOWEST_OFFER);
        if (currentLowestRaw) offerPlaceholder = `Current Lowest Offer: ${currentLowestRaw}`;
      }

      const modal = new ModalBuilder()
        .setCustomId(`seller_offer_modal:${sourceType}:${sourceRecordId || ''}:${messageId}`)
        .setTitle('Your Offer');

      modal.addComponents(
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
    
        // FIXED — this never encoded sourceType/orderId, so the retry
        // button's later re-opened modal always fell back to
        // sourceType="order" (hardcoded default in the modal-submit
        // handler) — meaning a Member WTB retry got silently treated
        // as a Store Order: wrong table lookup, no confirmation DM,
        // and the offer never linked to the actual Member WTB (so it
        // never showed up in Buying either). Now carries both through.
        const retryCustomId =
          interaction.guildId && interaction.channelId
            ? `retry_offer:${sourceType}:${orderId || ''}:${interaction.guildId}:${interaction.channelId}:${messageId}`
            : null;
    
        // Who is bidding now follows from the Discord ID of whoever clicked.
        // That saves more than typing: the seller used to fill in a Seller ID
        // themselves and nobody checked it was theirs, so anyone could bid on
        // behalf of any seller by guessing a number.
        let sellerLookup = null;

        try {
          sellerLookup = await portalPost('/api/internal/seller-by-discord', {
            discord_id: interaction.user.id
          });
        } catch (lookupErr) {
          console.error('seller-by-discord failed:', lookupErr);

          await interaction.editReply({
            content: '⚠️ Could not reach the seller database. Please try again in a moment.'
          }).catch(() => null);
          return;
        }

        if (!sellerLookup?.found) {
          pendingOffers.set(interaction.user.id, {
            retryCustomId,
            vatTypeRaw: interaction.fields.getTextInputValue('vat_type'),
            offerRaw: interaction.fields.getTextInputValue('offer_price'),
            at: Date.now()
          });

          await interaction.editReply({
            embeds: [NOT_LINKED_EMBED],
            components: notLinkedComponents()
          }).catch(() => null);

          await dmNotLinked(interaction.user);

          return;
        }

        const sellerCode = sellerLookup.seller_id;
    
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
        
          const memberWtbFulfillmentStatus = String(sourceRecord.get('Fulfillment Status') || '').trim();
        
          if (['Confirmed', 'Allocated', 'Fulfilled', 'Cancelled'].includes(memberWtbFulfillmentStatus)) {
            await interaction.editReply({
              content: '❌ This WTB is no longer open for offers.'
            }).catch(() => null);
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

        // The record is already fixed by the Discord ID above. Fetched only
        // because the VAT check below needs VAT ID and Country.
        const sellerRecordId = sellerLookup.seller_record_id;
        const sellerRecordForOffer = await base(sellersTableName).find(sellerRecordId).catch(() => null);

        if (!sellerRecordForOffer) {
          await interaction.editReply({
            content: `❌ Your seller profile could not be loaded. Please open a ticket in ${SUPPORT_CHANNEL_MENTION}.`
          }).catch(() => null);
          return;
        }

        const sellers = [sellerRecordForOffer];

        // Block based on the seller's own registration profile (VAT ID +
        // Country): private seller (no VAT ID) → Margin only; Dutch
        // company → no VAT0; non-Dutch company → no VAT21.
        const sellerVatEligibilityError = validateSellerVatEligibility(
          sellers[0]?.get('VAT ID'),
          sellers[0]?.get('Country'),
          vatInput
        );
        if (sellerVatEligibilityError) {
          await interaction.editReply({ content: `❌ ${sellerVatEligibilityError}` }).catch(() => null);
          await safeDMWithRetry(interaction.user, `❌ ${sellerVatEligibilityError}\n\nYour offer was **not** saved. You can try again by clicking the button below.`, retryCustomId);
          return;
        }
        
        const existingOffer = orderId
          ? await findExistingSellerOffer(sourceType, orderId, sellerRecordId)
          : null;
    
        // undercut logic
        if (orderId) {
          const lowest = await getCurrentLowest(sourceType, orderId, existingOffer?.id || null);
          if (lowest) {
            const isFirstMemberWtbOffer =
              sourceType === 'member_wtb' &&
              !existingOffer &&
              parseNumeric(sourceRecord?.get('Current Lowest Offer')) === null &&
              parseNumeric(sourceRecord?.get('Lowest Offer')) === null;

            const maxAllowedGross = isFirstMemberWtbOffer
              ? lowest.normalized
              : lowest.normalized - MIN_UNDERCUT_STEP;

            // Same line as the HTTP route above - both ways in have to be
            // equally traceable, or you end up trusting the one you can see.
            console.log(
              `⚖️ Ceiling for ${sourceType} ${orderId}: ` +
              `${maxAllowedGross.toFixed(2)} (basis ${lowest.basis}, raw ${lowest.normalized}) ` +
              `vs offer ${normalizedOffer.toFixed(2)}`
            );
    
            if (normalizedOffer > maxAllowedGross + 1e-9) {
              const lowestStr = formatLowestForDisplay(lowest);
    
              let maxForSeller = maxAllowedGross;
              // FIXED — same hardcoded 1.21 as the HTTP path above; see
              // vat0CeilingDivisor for why the basis decides the divisor.
              if (vatInput === 'VAT0') maxForSeller = maxAllowedGross / vat0CeilingDivisor(lowest);
    
              const maxForSellerRounded = Math.floor(maxForSeller);

              const maxDisplay = `€${maxForSellerRounded} (${vatInput})`;
              const altDisplay = '';
    
              const msg =
                `❌ Offer too high.\n` +
                `Current lowest: **${lowestStr}**\n` +
                (
                  isFirstMemberWtbOffer
                    ? `Max allowed for this WTB: **${maxDisplay}${altDisplay}**.`
                    : `Your offer must be at least **€${MIN_UNDERCUT_STEP.toFixed(2)}** lower than that.\n` +
                      `Max allowed for your VAT type: **${maxDisplay}${altDisplay}**.`
                );
    
              await interaction.editReply({ content: msg }).catch(() => null);
              await safeDMWithRetry(interaction.user, `${msg}\n\nYour offer was **not** saved. You can try again by clicking the button below.`, retryCustomId);
              return;
            }
          }
        }

        // OPTIONAL: store/refresh Discord ID on the Seller record (editable field!)
        const SELLER_DISCORD_ID_FIELD = 'Discord ID';

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
          'Offer Date': new Date().toISOString(),
          'Seller ID': [sellerRecordId]
        };
        
        if (orderId) {
          fields[getSourceConfig(sourceType).linkedOfferField] = [orderId];
        }
        
        let savedOffer;

        const freshExistingOffer = orderId
          ? await findExistingSellerOffer(sourceType, orderId, sellerRecordId)
          : null;
        
        if (freshExistingOffer) {
          savedOffer = await base(sellerOffersTableName).update(freshExistingOffer.id, fields);
        } else {
          savedOffer = await base(sellerOffersTableName).create(fields);
        }
        
        if (orderId) {
          const lowestAfterSave = await getCurrentLowest(sourceType, orderId);
        
          if (lowestAfterSave && Number.isFinite(lowestAfterSave.raw)) {
            const updateFields = {};
        
            if (sourceType === "member_wtb") {
              updateFields["Current Lowest Offer"] = lowestAfterSave.raw;
              updateFields["Current Lowest Normalized"] = lowestAfterSave.normalized;
              updateFields["Current Lowest Seller Offer"] = [savedOffer.id];
        
              updateFields["New Offer Available"] = false;
              updateFields["Offer Sent?"] = true;
        
              updateFields["Lowest Offer"] = lowestAfterSave.raw;
              updateFields["Lowest Offer Normalized"] = lowestAfterSave.normalized;
              updateFields["Lowest Offer VAT Type"] = lowestAfterSave.vatType;
              updateFields["Lowest Offer Seller ID"] = [sellerRecordId];
            }
        
            if (Object.keys(updateFields).length) {
              await getSourceTable(sourceType).update(orderId, updateFields);

              if (
                sourceType === "member_wtb" &&
                !isMemberWtbAutoAccept(sourceRecord) &&
                KC_PORTAL_BASE_URL &&
                KC_PORTAL_SECRET
              ) {
                await fetch(`${KC_PORTAL_BASE_URL}/api/member-wtb/send-current-offer-to-buyer`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "x-kc-secret": KC_PORTAL_SECRET
                  },
                  body: JSON.stringify({
                    member_wtb_record_id: orderId
                  })
                }).catch((err) => {
                  console.error("Failed to send current offer to buyer:", err);
                });
              }
            }
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
        
          await disableSellerOfferMessages(orderId, sourceType);

          await getSourceTable(sourceType).update(orderId, {
            'Fulfillment Status': 'Confirmed'
          }).catch(() => null);
        
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
    /* ---- CLAIM PROFILE ----
     *
     * For sellers with a Seller ID from before we recorded the Discord ID.
     * One time only: Seller ID plus email, then a code to that address. After
     * that they are known and never need this again.
     *
     * Discord allows no modal in reply to a modal, hence the alternation
     * button -> modal -> button -> modal.
     */
    if (interaction.isButton() && interaction.customId === 'claim_start') {
      await interaction.showModal(buildClaimProfileModal());
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'claim_profile_modal') {
      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      const sellerIdInput = interaction.fields.getTextInputValue('claim_seller_id').trim();
      const emailInput = interaction.fields.getTextInputValue('claim_email').trim();

      let result;

      try {
        result = await portalPost('/api/internal/claim/start', {
          discord_id: interaction.user.id,
          seller_id: sellerIdInput,
          email: emailInput
        });
      } catch (err) {
        console.error('claim/start failed:', err);

        await interaction.editReply({
          content: `⚠️ Something went wrong. Please try again, or open a ticket in ${SUPPORT_CHANNEL_MENTION}.`
        }).catch(() => null);
        return;
      }

      if (!result?.ok) {
        await interaction.editReply({
          content: `❌ ${result?.error || 'We could not match that Seller ID and email.'}\n\nNeed help? Open a ticket in ${SUPPORT_CHANNEL_MENTION}.`
        }).catch(() => null);
        return;
      }

      await interaction.editReply({
        content: [
          `📧 We sent a 6-digit code to **${emailInput}**.`,
          '',
          'Enter it below to finish linking. The code expires in 15 minutes.'
        ].join('\n'),
        components: [
          {
            type: 1,
            components: [{ type: 2, style: 1, label: 'Enter my code', custom_id: 'claim_code' }]
          }
        ]
      }).catch(() => null);

      return;
    }

    if (interaction.isButton() && interaction.customId === 'claim_code') {
      const modal = new ModalBuilder()
        .setCustomId('claim_code_modal')
        .setTitle('Enter your code');

      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('claim_code_value')
            .setLabel('6-digit code from your email')
            .setPlaceholder('123456')
            .setStyle(TextInputStyle.Short)
            .setMinLength(6)
            .setMaxLength(6)
            .setRequired(true)
        )
      );

      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'claim_code_modal') {
      await interaction.deferReply({ ephemeral: true }).catch(() => null);

      let result;

      try {
        result = await portalPost('/api/internal/claim/confirm', {
          discord_id: interaction.user.id,
          discord_tag: interaction.user.username,
          code: interaction.fields.getTextInputValue('claim_code_value').trim()
        });
      } catch (err) {
        console.error('claim/confirm failed:', err);

        await interaction.editReply({
          content: `⚠️ Something went wrong. Please try again, or open a ticket in ${SUPPORT_CHANNEL_MENTION}.`
        }).catch(() => null);
        return;
      }

      if (!result?.ok) {
        await interaction.editReply({
          content: `❌ ${result?.error || 'That code is not correct.'}`,
          components: [
            {
              type: 1,
              components: [{ type: 2, style: 2, label: 'Try again', custom_id: 'claim_code' }]
            }
          ]
        }).catch(() => null);
        return;
      }

      // Linked. Their earlier input was kept, so they can carry straight on
      // with the offer they got stuck on instead of starting over. The cache
      // still says "not found"; that is no longer true.
      forgetSellerLookup(interaction.user.id);

      const pending = pendingOffers.get(interaction.user.id);
      pendingOffers.delete(interaction.user.id);

      const lines = [
        `✅ Linked. Your Seller ID **${result.seller_id}** is now connected to this Discord account.`,
        '',
        'You never have to enter it again.'
      ];

      const components = [];

      if (pending?.retryCustomId) {
        lines.push('', 'Click below to finish the offer you started.');

        components.push({
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Continue my offer', custom_id: pending.retryCustomId }
          ]
        });
      }

      await interaction.editReply({ content: lines.join('\n'), components }).catch(() => null);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('retry_offer:')) {
      const parts = interaction.customId.split(':');

      // FIXED — old customId was retry_offer:guildId:channelId:messageId
      // (4 parts) with no sourceType/orderId at all, so the reopened
      // modal always fell back to sourceType="order" downstream —
      // meaning a Member WTB retry got silently treated as a Store
      // Order: wrong table lookup, no confirmation DM, offer never
      // linked to the actual Member WTB (so never showed up in
      // Buying either). Now retry_offer:sourceType:orderId:guildId:
      // channelId:messageId (6 parts) carries both through; the else
      // branch keeps the old 4-part shape working for any already-
      // sent DM whose retry button predates this fix.
      let sourceType = 'order';
      let orderId = null;
      let messageId;

      if (parts.length >= 6) {
        sourceType = normalizeSourceType(parts[1]);
        orderId = parts[2] || null;
        messageId = parts[5];
      } else {
        messageId = parts[3];
      }

      // Re-open the offer modal with the same placeholder logic — now
      // correctly looks up the right table (Member WTBs vs Orders)
      // instead of always assuming Orders.
      let sourceRecord = null;
      try {
        if (orderId) {
          sourceRecord = await base(getSourceConfig(sourceType).tableName).find(orderId);
        } else {
          const recs = await base(getSourceConfig(sourceType).tableName)
            .select({
              filterByFormula: `SEARCH("${messageId}", {${ORDER_FIELD_SELLER_MSG_IDS}})`,
              maxRecords: 1
            })
            .firstPage();
          sourceRecord = recs[0] || null;
        }
      } catch (_) {}

      // Same check as on the normal offer button: with no profile linked yet,
      // straight to the claim modal instead of the offer modal.
      const retrySellerCheck = await lookupSellerCached(interaction.user.id);

      if (retrySellerCheck && !retrySellerCheck.found) {
        pendingOffers.set(interaction.user.id, {
          retryCustomId: interaction.customId,
          at: Date.now()
        });

        await interaction.reply({
          embeds: [NOT_LINKED_EMBED],
          components: notLinkedComponents(),
          ephemeral: true
        }).catch(() => null);

        await dmNotLinked(interaction.user);
        return;
      }

      let offerPlaceholder = 'Enter your offer (e.g. 140)';
      if (sourceRecord) {
        const currentLowestRaw = sourceRecord.get(ORDER_FIELD_CURRENT_LOWEST_OFFER);
        if (currentLowestRaw) offerPlaceholder = `Current Lowest Offer: ${currentLowestRaw}`;
      }

      const modal = new ModalBuilder()
        .setCustomId(`seller_offer_modal:${sourceType}:${orderId || ''}:${messageId}`)
        .setTitle('Your Offer');

      modal.addComponents(
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
