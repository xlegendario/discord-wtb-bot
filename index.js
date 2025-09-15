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
} from 'discord.js';

dotenv.config();

// Helpers
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

const app = express();
const PORT = process.env.PORT || 3000;

// Config
const WTB_INBOX_CHANNEL = process.env.WTB_INBOX_CHANNEL || 'wtb-requests'; // where the button message is posted
const WTB_PRIVATE_PREFIX = process.env.WTB_PRIVATE_PREFIX || 'wtb';         // prefix for new channel names
const WTB_STAFF_ROLE_ID = process.env.WTB_STAFF_ROLE_ID || '';              // optional staff role
const WTB_CATEGORY_ID = process.env.WTB_CATEGORY_ID || '';                  // preferred category for new channels
const WTB_CATEGORY_NAME = process.env.WTB_CATEGORY_NAME || '';              // fallback by name

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

client.on('ready', () => console.log(`✅ Logged in as ${client.user.tag}`));
client.login(process.env.DISCORD_TOKEN);

// -----------------------------
// Button interactions
// -----------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const customId = interaction.customId;

  if (customId.startsWith('open_wtb_')) {
    // customId format: open_wtb_<orderNumber>
    const orderNumber = customId.replace('open_wtb_', '').trim();

    try {
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

      // Determine username to include in the new channel name
      const member = interaction.member || await guild.members.fetch(interaction.user.id);
      const displayName = member?.nickname || member?.displayName || interaction.user.username;

      // Build new channel name: <prefix>-<orderNumber>-<username>
      const channelName = safeSlug(`${WTB_PRIVATE_PREFIX}-${orderNumber}-${displayName}`);

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

        await target.send(
          `👋 Welcome <@${interaction.user.id}>! This private WTB channel for **Order ${orderNumber}** is now open.`
        );
      } else {
        // Ensure the clicker has access if channel existed
        await target.permissionOverwrites.edit(interaction.user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
      }

      // Disable the button and point to the created channel
      const disabledRow = new ActionRowBuilder().addComponents(
        ...interaction.message.components[0].components.map(btn => ButtonBuilder.from(btn).setDisabled(true))
      );

      await interaction.update({
        content: `✅ Opened WTB channel: <#${target.id}>`,
        components: [disabledRow],
      });
    } catch (err) {
      console.error('❌ Failed to open WTB channel:', err);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: '❌ Could not open WTB channel.' });
      } else {
        await interaction.reply({ content: '❌ Could not open WTB channel.', ephemeral: true });
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
    brand
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

    // Build embed WITHOUT order number (you requested order number be used only for naming)
    const embed = new EmbedBuilder()
      .setTitle(`🛒 WTB Request`)
      .setColor('#2ecc71')
      .setDescription(
        `**Item Details**\n` +
        (brandName ? `Brand: ${brandName}\n` : '') +
        (name ? `Product: ${name}\n` : '') +
        (skuMain ? `SKU: ${skuMain}\n` : '') +
        (skuSoftVal ? `SKU Soft: ${skuSoftVal}\n` : '') +
        (sizeStr ? `Size: ${sizeStr}\n` : '') +
        `\nClick the button below to open a private WTB channel.`
      );

    // Button carries order number only; channel name will be "<prefix>-<order>-<username>"
    const orderForButton = getFirstValue(order_number) || String(Date.now());

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`open_wtb_${orderForButton}`)
        .setLabel('Open WTB Channel')
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
