import dotenv from 'dotenv';
import express from 'express';
import bodyParser from 'body-parser';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
  Events,
  MessageFlags,
} from 'discord.js';

// If you run Node < 18 locally, uncomment next line and install node-fetch
// import fetch from 'node-fetch';

dotenv.config();

// ===== Helpers =====
function getFirstValue(value) {
  return Array.isArray(value) ? (value[0] || "").toString().trim() : (value || "").toString().trim();
}
function safeSlug(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 90);
}

// Airtable helpers (status gate)
const AT_API_KEY     = process.env.AIRTABLE_API_KEY || '';
const AT_BASE_ID     = process.env.AIRTABLE_BASE_ID || '';
const AT_TABLE_NAME  = process.env.AIRTABLE_TABLE_NAME || '';
const AT_STATUS_FIELD = process.env.AIRTABLE_STATUS_FIELD || 'Fulfillment Status';
const AT_ACTIVE_VALUE = process.env.AIRTABLE_ACTIVE_STATUS_VALUE || 'Outsource';

async function getAirtableStatus(recordId) {
  if (!AT_API_KEY || !AT_BASE_ID || !AT_TABLE_NAME || !recordId) return null;
  const url = `https://api.airtable.com/v0/${AT_BASE_ID}/${encodeURIComponent(AT_TABLE_NAME)}/${recordId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AT_API_KEY}` } });
  if (!res.ok) return null;
  const json = await res.json();
  return json?.fields?.[AT_STATUS_FIELD] ?? null;
}

// ===== App =====
const app = express();
const PORT = process.env.PORT || 3000;

// Config
const WTB_INBOX_CHANNEL = process.env.WTB_INBOX_CHANNEL || 'wtb-requests'; // where the button message is posted
const WTB_PRIVATE_PREFIX = process.env.WTB_PRIVATE_PREFIX || '';           // prefix for new channel names (leave blank per your preference)
const WTB_STAFF_ROLE_ID = process.env.WTB_STAFF_ROLE_ID || '';            // optional staff role
const WTB_CATEGORY_ID = process.env.WTB_CATEGORY_ID || '';                // preferred category for new channels
const WTB_CATEGORY_NAME = process.env.WTB_CATEGORY_NAME || '';            // fallback by name

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, (c) => console.log(`✅ Logged in as ${c.user.tag}`));
client.login(process.env.DISCORD_TOKEN);

// -----------------------------
// Button interactions
// -----------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;

  // customId format: open_wtb|<orderNumber>|<recordId>
  if (customId.startsWith('open_wtb|')) {
    const parts = customId.split('|');
    const orderNumber = (parts[1] || '').trim();
    const recordId = (parts[2] || '').trim();

    try {
      // 1) Gate on Airtable status
      let status = null;
      try { status = await getAirtableStatus(recordId); } catch (_) {}
      const isActive = !status || status === AT_ACTIVE_VALUE; // if we can't read status, allow by default

      // If closed -> disable the button for everyone and tell the clicker
      if (!isActive) {
        const disabledRow = new ActionRowBuilder().addComponents(
          ...interaction.message.components[0].components.map(btn =>
            ButtonBuilder.from(btn).setDisabled(true)
          )
        );
        await interaction.update({
          content: `🚫 WTB closed — this item is no longer needed`,
          components: [disabledRow],
        });
        return;
      }

      // 2) Active -> create/reuse the private channel and DO NOT disable the button
      const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
      const channels = await guild.channels.fetch();

      // Find target parent category (ID first, then name, else fall back to inbox parent)
      let parentId = null;
      if (WTB_CATEGORY_ID) parentId = WTB_CATEGORY_ID;
      else if (WTB_CATEGORY_NAME) {
        const cat = channels.find(c => c?.type === ChannelType.GuildCategory && c?.name === WTB_CATEGORY_NAME);
        if (cat) parentId = cat.id;
      }
      if (!parentId) {
        const inbox = channels.find(c => c?.name === WTB_INBOX_CHANNEL);
        parentId = inbox?.parentId ?? null;
      }

      // Username in the new channel name (works without fetching members if intent is disabled)
      const displayName = interaction.member?.nickname || interaction.user.username;

      // Build new channel name: <orderNumber>-<username> (prefix optional)
      const baseName = safeSlug(`${orderNumber}-${displayName}`);
      const channelName = WTB_PRIVATE_PREFIX ? safeSlug(`${WTB_PRIVATE_PREFIX}-${baseName}`) : baseName;

      // Reuse existing channel if name collision
      let target = channels.find(c => c?.type === ChannelType.GuildText && c?.name === channelName);

      // Permission overwrites for private channel
      const overwrites = [
        { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
        {
          id: client.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageChannels,
          ],
        },
      ];
      if (WTB_STAFF_ROLE_ID) {
        overwrites.push({
          id: WTB_STAFF_ROLE_ID,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        });
      }

      if (!target) {
        target = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: parentId || undefined,
          permissionOverwrites: overwrites,
          reason: `WTB channel opened by ${interaction.user.tag} for order ${orderNumber}`,
        });

        // Pull product + size from the original embed description (ignore CTA line)
        const emb = interaction.message.embeds?.[0];
       let productName = '';
       let sizeText = '';

       if (emb?.description) {
         // Split into lines, trim, drop empties
         const rawLines = emb.description.split('\n').map(s => s.trim()).filter(Boolean);
         // Remove the CTA line we appended (“Click the button below…”)
         const lines = rawLines.filter(l => !/click the button/i.test(l));

         // Our content lines are:
         // 0: **Product Name**
         // 1: SKU
         // 2: (optional) SKU Soft (if different)
         // 3: Size
         // 4: Brand (last)
         productName = (lines[0] || '').replace(/\*\*/g, '');

         // Take the second-to-last as Size (since last is Brand)
         if (lines.length >= 4) {
           sizeText = lines[lines.length - 2];
         } else if (lines.length >= 3) {
           // If brand is missing for some reason, size will be the 3rd item
           sizeText = lines[2];
         }
       }

       const welcomeMsg =
         `👋 Welcome <@${interaction.user.id}>! Please share your offer for **${productName}${sizeText ? ` - ${sizeText}` : ''}** below; a staff member will be with you shortly.`;

       await target.send(welcomeMsg);

      } else {
        // Ensure the clicker has access if channel existed
        await target.permissionOverwrites.edit(interaction.user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
      }

      // IMPORTANT: keep the button clickable → send an EPHEMERAL reply instead of updating the message
      await interaction.reply({
        content: `✅ Opened WTB channel: <#${target.id}>`,
        flags: MessageFlags.Ephemeral,
      });

    } catch (err) {
      console.error('❌ Failed to open WTB channel:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Could not open WTB channel.' });
      } else {
        await interaction.reply({ content: '❌ Could not open WTB channel.', flags: MessageFlags.Ephemeral });
      }
    }
  }
});

app.use(bodyParser.json());

// -----------------------------
// Webhook endpoint
// -----------------------------
app.post('/', async (req, res) => {
  // Optional protection: shared secret
  if (process.env.WEBHOOK_SECRET) {
    const auth = req.get('authorization') || '';
    if (auth !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const {
    trigger_type,
    order_number,     // used ONLY for naming the channel
    product_name,
    sku,
    sku_soft,
    size,
    brand,
    picture_url,
    image_url,
    record_id         // ← include this so the button can check Airtable
  } = req.body;

  if (trigger_type !== 'send-wtb-webhook') {
    return res.status(400).json({ error: 'Unsupported trigger_type' });
  }

  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const channels = await guild.channels.fetch();

    // Find the inbox channel (by name anywhere in the guild)
    const inbox = channels.find(c => c?.name === WTB_INBOX_CHANNEL);
    if (!inbox) {
      console.error('❌ Inbox channel not found.');
      return res.status(404).json({ error: 'WTB inbox channel not found' });
    }

    // Clean values for the embed
    const name = getFirstValue(product_name);
    const brandName = getFirstValue(brand);
    const sizeStr = getFirstValue(size);
    const skuMain = getFirstValue(sku);
    const skuSoftVal = getFirstValue(sku_soft);

    // Build minimal, stacked lines like your screenshot
    const lines = [
      name ? `**${name}**` : null,
      skuMain || null,
      (skuSoftVal && skuSoftVal !== skuMain) ? skuSoftVal : null,
      sizeStr || null,
      brandName || null,
    ].filter(Boolean).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🚨 NEW DEAL 🚨')
      .setColor('#f1c40f') // yellow accent bar
      .setDescription(`${lines}\n\nClick the button below to open a ticket and share your offer.`);

    // Add product image if provided (prefers picture_url, falls back to image_url)
    const rawPic = getFirstValue(picture_url || image_url);
    if (rawPic && /^https?:\/\//i.test(rawPic)) {
      embed.setImage(rawPic); // big image under the embed
    }

    // Button carries order number and record id (for Airtable status check)
    const orderForButton = getFirstValue(order_number) || String(Date.now());
    const recordForButton = getFirstValue(record_id) || '';
    const customId = `open_wtb|${orderForButton}|${recordForButton}`;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(customId)
        .setLabel('Open WTB Ticket')
        .setStyle(ButtonStyle.Success)
    );

    await inbox.send({ embeds: [embed], components: [row] });

    return res.json({ ok: true, routed_to: 'send-wtb-webhook' });
  } catch (err) {
    console.error('❌ Error in send-wtb-webhook:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (_, res) => res.send('OK'));
app.listen(PORT, () => console.log(`🚀 WTB bot server listening on :${PORT}`));
