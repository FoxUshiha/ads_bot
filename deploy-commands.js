// deploy-commands.js
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

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
        .setDescription('Cooldown entre anúncios em segundos (mín 1800, máx 86400)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('advertise')
    .setDescription('Abrir painel de criação de anúncio')
].map(cmd => cmd.toJSON());

// Carrega dados do .env
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID; // opcional: só se quiser registrar em 1 servidor

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('⏳ Registrando comandos (slash)...');

    if (GUILD_ID) {
      // Registro em um servidor específico (mais rápido para dev/teste)
      await rest.put(
        Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
        { body: commands }
      );
      console.log('✅ Comandos registrados (escopo de guild).');
    } else {
      // Registro global (leva até 1h para atualizar)
      await rest.put(
        Routes.applicationCommands(CLIENT_ID),
        { body: commands }
      );
      console.log('✅ Comandos registrados (escopo global).');
    }
  } catch (err) {
    console.error('❌ Erro ao registrar comandos:', err);
  }
})();
