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

function getFirstValue(value) {
  return Array.isArray(value) ? (value[0] || "").toString().trim() : (value || "").toString().trim();
}

// Slugify a safe channel name (lowercase, dash-separated)
function safeChannelName(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 90);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Config (override via env)
const WTB_INBOX_CHANNEL = process.env.WTB_INBOX_CHANNEL || 'wtb-requests'; // where the inbox button is posted
const WTB_PRIVATE_PREFIX = process.env.WTB_PRIVATE_PREFIX || 'wtb';         // prefix for new private channels
const WTB_STAFF_ROLE_ID = process.env.WTB_STAFF_ROLE_ID || '';              // optional: role that always has access

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel],
});

client.on('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.login(process.env.DISCORD_TOKEN);

// -----------------------------
// Button interactions
// -----------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const customId = interaction.customId;

  if (customId.startsWith('open_wtb_')) {
    const payloadId = customId.replace('open_wtb_', '');

    try {
      const guildId = process.env.DISCORD_GUILD_ID; // single-guild version
      const guild = await client.guilds.fetch(guildId);
      const channels = await guild.channels.fetch();

      // Locate inbox channel (e.g., #wtb-requests)
      const inboxChannel = channels.find((c) => c?.name === WTB_INBOX_CHANNEL);
      const parentId = inboxChannel?.parentId ?? null;

      // Derive a readable channel name from the embed title or payload id
      const embeds = interaction.message.embeds || [];
      const title = embeds[0]?.title || '';
      const orderNoMatch = title.match(/#(\w[\w-]*)/); // “WTB Request #12345”
      const orderPart = orderNoMatch ? `-${orderNoMatch[1]}` : '';
      const channelName = safeChannelName(`${WTB_PRIVATE_PREFIX}${orderPart || `-${String(payloadId).slice(-6)}`}`);

      // If exists, reuse; else create
      let target = channels.find((c) => c?.name === channelName && c?.type === ChannelType.GuildText);

      if (!target) {
        const overwrites = [
          // Hide from everyone by default
          { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
          // Let the clicker in
          {
            id: interaction.user.id,
            allow: [
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.SendMessages,
              PermissionsBitField.Flags.ReadMessageHistory,
            ],
          },
          // Allow the bot
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

        target = await guild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: parentId || undefined,
          permissionOverwrites: overwrites,
          reason: `WTB channel opened by ${interaction.user.tag} via button`,
        });

        await target.send(
          `👋 Welcome <@${interaction.user.id}>! This private WTB channel is now open. A team member will be with you shortly.`
        );
      } else {
        // Ensure the clicker has access if channel already existed
        await target.permissionOverwrites.edit(interaction.user.id, {
          ViewChannel: true,
          SendMessages: true,
          ReadMessageHistory: true,
        });
      }

      // Disable the button and link the new channel
      const disabledRow = new ActionRowBuilder().addComponents(
        ...interaction.message.components[0].components.map((btn) =>
          ButtonBuilder.from(btn).setDisabled(true)
        )
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
  // Optional: protect with a shared secret
  if (process.env.WEBHOOK_SECRET) {
    const auth = req.get('authorization') || '';
    if (auth !== `Bearer ${process.env.WEBHOOK_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const {
    trigger_type,
    store_name,
    product_name,
    size,
    sku,
    shopify_order_number,
    record_id,
    selling_price,
  } = req.body;

  if (trigger_type !== 'send-wtb-webhook') {
    return res.status(400).json({ error: 'Unsupported trigger_type' });
  }

  try {
    const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
    const channels = await guild.channels.fetch();

    const storeName = getFirstValue(store_name);

    // Prefer inbox under the store’s category (if you group by store). Otherwise any channel with that name.
    let inbox = channels.find(
      (c) =>
        c?.name === WTB_INBOX_CHANNEL &&
        c?.parent?.name?.toLowerCase() === storeName?.toLowerCase()
    );
    if (!inbox) inbox = channels.find((c) => c?.name === WTB_INBOX_CHANNEL);

    if (!inbox) {
      console.error('❌ WTB inbox channel not found.');
      return res.status(404).json({ error: 'WTB inbox channel not found' });
    }

    const name = getFirstValue(product_name);
    const sizeStr = getFirstValue(size);
    const skuStr = getFirstValue(sku);
    const orderNo = getFirstValue(shopify_order_number);
    const idForButton = record_id || orderNo || String(Date.now());

    const embed = new EmbedBuilder()
      .setTitle(`🛒 WTB Request #${orderNo || record_id || '—'}`)
      .setColor('#2ecc71')
      .setDescription(
        `**Item Details**\n` +
          `${name || '—'}\n` +
          (skuStr ? `SKU: ${skuStr}\n` : '') +
          (sizeStr ? `Size: ${sizeStr}\n` : '') +
          (selling_price ? `Target / Price: €${selling_price}\n` : '') +
          `\nClick the button below to open a private WTB channel.`
      )
      .setFooter({ text: `store: ${storeName || '-'}  •  id: ${record_id || '-'}` });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`open_wtb_${idForButton}`)
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
