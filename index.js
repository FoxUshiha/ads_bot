// index.js
import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, PermissionsBitField, ChannelType,
  REST, Routes, SlashCommandBuilder
} from 'discord.js';
import {
  db, initSchema, getServer, upsertServer, setLatest,
  insertUserAd, decrementTimes, addToAdsQueue, addToPaymentQueue,
  popNextPayment, deletePayment, deleteAdsQueue, cleanupSequencesIfEmpty,
  upsertAdMeta, getAdMeta
} from './database.js';
import { CoinAPI } from './coinApi.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel]
});

const coinApi = new CoinAPI({
  baseURL: process.env.COIN_API_URL,
  timeout: Number(process.env.COIN_API_TIMEOUT || 12000)
});

const AD_PRICE = Number(process.env.AD_PRICE || 0.001);
const ROUND_EVERY_MS = 1 * 10 * 1000; // 15 minutos fixo

const PANEL_BUTTON_ID = 'ads_panel_open';
const MODAL_ID = 'ads_modal';

initSchema();

// ====== Definição dos comandos ======
const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configura o sistema de anúncios neste servidor')
    .addStringOption(opt =>
      opt.setName('ownerid')
        .setDescription('Coin Owner ID que receberá os pagamentos')
        .setRequired(true)
    )
    .addChannelOption(opt =>
      opt.setName('panel')
        .setDescription('Canal onde o painel de anúncios será enviado')
        .setRequired(true)
    )
    .addChannelOption(opt =>
      opt.setName('channel')
        .setDescription('Canal onde os anúncios serão exibidos')
        .setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('cooldown')
        .setDescription('Cooldown entre anúncios em segundos (mín 300, máx 86400)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('advertise')
    .setDescription('Abrir painel de criação de anúncio')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

// ====== Registro automático de comandos ======
async function registerCommands() {
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("🌍 Comandos registrados globalmente.");

    for (const [guildId] of client.guilds.cache) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
        console.log(`📌 Comandos registrados no servidor ${guildId}`);
      } catch (err) {
        console.error(`❌ Falha ao registrar comandos em ${guildId}:`, err.message);
      }
    }
  } catch (err) {
    console.error("❌ Erro ao registrar comandos:", err.message);
  }
}

client.on("guildCreate", async (guild) => {
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: commands });
    console.log(`✅ Comandos registrados automaticamente no novo servidor: ${guild.id}`);
  } catch (err) {
    console.error(`❌ Erro ao registrar comandos no novo servidor ${guild.id}:`, err.message);
  }
});

client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);
  await registerCommands();

  setInterval(runDistributionRound, ROUND_EVERY_MS);
  runDistributionRound().catch(console.error);
  runPaymentWorker().catch(console.error);
});

// Helpers
const clampCooldown = (sec) => Math.max(300, Math.min(86400, sec | 0));
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ensureAdminOrOwner(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) || (member.id === member.guild.ownerId);
}

// Painel embed
function buildPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('📣 Discord Advertising')
    .setDescription('Clique em **Anunciar** ou use `/advertise` para criar um anúncio pago via Coin Card.\nO pagamento é debitado **por exibição** após confirmação da API.')
    .setColor(0x00A3FF)
    .addFields(
      { name: 'Preço por exibição', value: `${AD_PRICE} coin`, inline: true }
    );
}

function buildAdvertiseModal() {
  return new ModalBuilder()
    .setCustomId(MODAL_ID)
    .setTitle('Discord Advertising')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('content').setLabel('Content').setStyle(TextInputStyle.Paragraph).setPlaceholder('Mensagem do anúncio').setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('link').setLabel('Link (https://)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('word').setLabel('Word (até 12 chars)').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(12)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('card').setLabel('Coin Card (ID)').setStyle(TextInputStyle.Short).setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('maxtimes').setLabel('Max Times (opcional)').setStyle(TextInputStyle.Short).setRequired(false)
      )
    );
}

function linkButton(label, url) {
  return new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(url);
}
function advertiseButton() {
  return new ButtonBuilder().setCustomId(PANEL_BUTTON_ID).setStyle(ButtonStyle.Primary).setLabel('Anunciar');
}

// ================== Slash /setup ==================
client.on('interactionCreate', async (itx) => {
  try {
    if (!itx.isChatInputCommand()) return;
    if (itx.commandName !== 'setup') return;

    if (!ensureAdminOrOwner(itx.member)) {
      return itx.reply({ content: '⚠️ Apenas administradores ou dono do servidor podem usar esse comando.', ephemeral: true });
    }

    const ownerid = itx.options.getString('ownerid') || null;
    const panelCh = itx.options.getChannel('panel');
    const adsCh = itx.options.getChannel('channel');
    let cooldown = itx.options.getInteger('cooldown');

    if (cooldown != null) cooldown = clampCooldown(cooldown);

    await upsertServer({
      ID: itx.guildId,
      Owner: ownerid,
      Panel: panelCh?.id,
      channel: adsCh?.id,
      cooldown
    });

    if (panelCh && panelCh.type === ChannelType.GuildText) {
      const row = new ActionRowBuilder().addComponents(advertiseButton());
      await panelCh.send({ embeds: [buildPanelEmbed()], components: [row] });
    }

    await itx.reply({ content: '✅ Configuração salva.', ephemeral: true });
  } catch (err) {
    console.error('setup error', err);
    if (itx.isRepliable()) itx.reply({ content: '❌ Erro ao salvar configuração.', ephemeral: true }).catch(() => { });
  }
});

// ================== Slash /advertise ==================
client.on('interactionCreate', async (itx) => {
  if (!itx.isChatInputCommand()) return;
  if (itx.commandName !== 'advertise') return;
  const modal = buildAdvertiseModal();
  await itx.showModal(modal);
});

// ================== Botão Anunciar ==================
client.on('interactionCreate', async (itx) => {
  if (!itx.isButton()) return;
  if (itx.customId !== PANEL_BUTTON_ID) return;
  const modal = buildAdvertiseModal();
  await itx.showModal(modal);
});

// ================== Modal submit ==================
client.on('interactionCreate', async (itx) => {
  if (!itx.isModalSubmit()) return;
  if (itx.customId !== MODAL_ID) return;

  const content = itx.fields.getTextInputValue('content');
  const link = itx.fields.getTextInputValue('link');
  const word = itx.fields.getTextInputValue('word');
  const card = itx.fields.getTextInputValue('card');
  const maxtimesRaw = itx.fields.getTextInputValue('maxtimes');

  if (!/^https?:\/\//i.test(link)) {
    return itx.reply({ content: '❌ Link inválido. Use http(s)://', ephemeral: true });
  }

  let times = null;
  if (maxtimesRaw && maxtimesRaw.trim()) {
    const n = Number(maxtimesRaw.trim());
    if (!Number.isInteger(n) || n <= 0) return itx.reply({ content: '❌ Max Times deve ser um número inteiro > 0.', ephemeral: true });
    times = n;
  }

  const server = await getServer(itx.guildId);
  if (!server || !server.Owner || !server.channel) {
    return itx.reply({ content: '❌ Este servidor não está configurado. Use `/setup`.', ephemeral: true });
  }

  const adsId = `${itx.user.id}:${Date.now()}`;
  await insertUserAd({ userId: itx.user.id, adsId, times, card });
  await upsertAdMeta({ AD_ID: adsId, User: itx.user.id, ad: content, link, msg: word });

  await itx.reply({ content: '✅ Anúncio registrado. Ele será enviado assim que os servidores estiverem fora do cooldown.', ephemeral: true });
});

// ================== Cooldown check ==================
async function serverEligible(guildId) {
  const s = await getServer(guildId);
  if (!s || !s.channel || !s.Owner) return false;
  const last = Number(s.latest || 0);
  const cd = clampCooldown(Number(s.cooldown || 300));
  return nowSec() - last >= cd;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ================== Distribuição global ==================
async function runDistributionRound() {
  try {
    const servers = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM servers`, [], (e, rows) => e ? reject(e) : resolve(rows || []));
    });
    const eligibles = [];
    for (const s of servers) if (await serverEligible(s.ID)) eligibles.push(s);
    if (!eligibles.length) return;

    const ads = await new Promise((resolve, reject) => {
      db.all(`SELECT * FROM users`, [], (e, rows) => e ? reject(e) : resolve(rows || []));
    });
    if (!ads.length) return;

    const shuffledServers = shuffle(eligibles);
    const shuffledAds = shuffle(ads);

    const toAdsQueue = [];
    const toPayQueue = [];
    for (let i = 0; i < shuffledServers.length; i++) {
      const server = shuffledServers[i];
      const ad = shuffledAds[i % shuffledAds.length];
      if (ad.times != null && ad.times <= 0) continue;

      const copy = await getAdMeta(ad.ADS_ID);
      if (!copy) continue;

      toAdsQueue.push({
        AD_ID: ad.ADS_ID,
        User: ad.ID,
        ad: copy.ad,
        link: copy.link,
        msg: copy.msg,
        Server: server.ID
      });

      toPayQueue.push({
        AD_ID: ad.ADS_ID,
        ID: ad.ID,
        card: ad.card,
        server_owner_id: server.Owner
      });
    }

    if (!toAdsQueue.length) return;

    await addToAdsQueue(toAdsQueue);
    await addToPaymentQueue(toPayQueue);

    const now = nowSec();
    await Promise.all(toAdsQueue.map(q => setLatest(q.Server, now)));

    const usedByAdsId = new Set(toAdsQueue.map(x => `${x.User}|${x.AD_ID}`));
    await Promise.all([...usedByAdsId].map(key => {
      const [uid, aid] = key.split('|');
      return decrementTimes(uid, aid);
    }));
  } catch (e) {
    console.error('runDistributionRound error', e);
  }
}

// ================== Worker de pagamento ==================
async function runPaymentWorker() {
  while (true) {
    try {
      const job = await popNextPayment();
      if (!job) {
        await cleanupSequencesIfEmpty();
        await sleep(1000);
        continue;
      }

      await CoinAPI.throttle1s();

      let ok = false;
      try {
        await coinApi.payFromCard({
          cardCode: job.card,
          toId: job.server_owner_id,
          amount: AD_PRICE
        });
        ok = true;
      } catch (e) {
        console.warn('Pagamento falhou para queue', job.queue, e?.response?.data || e.message);
      }

      await deletePayment(job.queue);

      const adsRow = await new Promise((resolve) => {
        db.get(`SELECT * FROM adsqueue WHERE AD_ID = ? ORDER BY queue ASC LIMIT 1`, [job.AD_ID], (e, row) => resolve(row || null));
      });

      if (!ok) {
        if (adsRow) await deleteAdsQueue(adsRow.queue);
        continue;
      }

      if (adsRow) {
        await postAd(adsRow.Server, adsRow);
        await deleteAdsQueue(adsRow.queue);
      }
    } catch (e) {
      console.error('payment worker loop error', e);
      await sleep(1000);
    }
  }
}

async function postAd(serverId, adsRow) {
  try {
    const s = await getServer(serverId);
    if (!s || !s.channel) return;
    const ch = await client.channels.fetch(s.channel).catch(() => null);
    if (!ch) return;

    const embed = new EmbedBuilder().setDescription(adsRow.ad).setColor(0x00A3FF);
    const row = new ActionRowBuilder().addComponents(linkButton(adsRow.msg || 'saiba mais', adsRow.link || 'https://'));

    await ch.send({ embeds: [embed], components: [row] });
  } catch (e) {
    console.error('postAd error', e);
  }
}

client.login(process.env.DISCORD_TOKEN);
