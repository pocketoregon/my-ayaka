require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// In-memory store
const guildConfigs = {};
const triviaState = {};
const chatHistories = {};

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  client.user.setActivity('!help | Powered by Gemini', { type: 'WATCHING' });
});

// ─── GREET NEW MEMBERS ────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  const cfg = guildConfigs[member.guild.id];
  if (!cfg?.welcomeChannelId) return;

  const channel = member.guild.channels.cache.get(cfg.welcomeChannelId);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`👋 Welcome to ${member.guild.name}, ${member.user.username}!`)
    .setDescription(cfg.welcomeMessage || 'Glad to have you here! Use `!help` to see what I can do.')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setTimestamp();

  channel.send({ embeds: [embed] });
});

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // ── !help ──────────────────────────────────────────────────────────────────
  if (command === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🤖 Bot Commands')
      .addFields(
        { name: '👋 Greetings', value: '`!hello` — Say hello\n`!bye` — Say goodbye', inline: true },
        { name: '🧠 Trivia', value: '`!trivia` — Start a quiz\n`!trivia <category>` — Themed quiz\n(Categories: science, history, sports, general)', inline: true },
        { name: '😂 Memes', value: '`!meme` — Random meme\n`!meme <topic>` — Topic meme', inline: true },
        { name: '💬 AI Chat', value: '`!chat <message>` — Chat with Gemini AI\n`!resetchat` — Clear chat history', inline: true },
        { name: '⚙️ Setup (Admin)', value: '`!setup welcome #channel` — Set welcome channel\n`!setup message <text>` — Set welcome message\n`!setup view` — View current config', inline: true },
      )
      .setFooter({ text: 'Powered by Google Gemini AI (Free)' });
    return message.reply({ embeds: [embed] });
  }

  // ── !hello / !hi ───────────────────────────────────────────────────────────
  if (command === 'hello' || command === 'hi' || command === 'hey') {
    const greetings = [
      `Hey there, **${message.author.username}**! 👋 How's it going?`,
      `Yo **${message.author.username}**! 🎉 Good to see you!`,
      `Hello, **${message.author.username}**! 😊 Hope you're having a great day!`,
      `What's up, **${message.author.username}**! 🤙`,
    ];
    return message.reply(greetings[Math.floor(Math.random() * greetings.length)]);
  }

  // ── !bye ───────────────────────────────────────────────────────────────────
  if (command === 'bye' || command === 'goodbye') {
    return message.reply(`Goodbye, **${message.author.username}**! 👋 See you around!`);
  }

  // ── !trivia ─────────────────────────────────────────────────────────────────
  if (command === 'trivia') {
    const categoryMap = { science: 17, history: 23, sports: 21, general: 9, geography: 22, music: 12 };
    const requestedCat = args[0]?.toLowerCase();
    const catId = categoryMap[requestedCat] || 9;
    const catName = requestedCat ? (requestedCat.charAt(0).toUpperCase() + requestedCat.slice(1)) : 'General Knowledge';

    try {
      const res = await fetch(`https://opentdb.com/api.php?amount=1&type=multiple&category=${catId}`);
      const data = await res.json();
      if (data.response_code !== 0) return message.reply('❌ Could not fetch trivia right now. Try again!');

      const q = data.results[0];
      const correct = decodeHtml(q.correct_answer);
      const allAnswers = shuffle([correct, ...q.incorrect_answers.map(decodeHtml)]);
      const labels = ['🅰', '🅱', '🆎', '🅾'];

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`🧠 Trivia — ${catName}`)
        .setDescription(`**${decodeHtml(q.question)}**`)
        .addFields(
          allAnswers.map((ans, i) => ({ name: `${labels[i]} Option ${i + 1}`, value: ans, inline: true }))
        )
        .setFooter({ text: `Difficulty: ${q.difficulty} • You have 15 seconds!` });

      const buttons = new ActionRowBuilder().addComponents(
        allAnswers.map((ans, i) =>
          new ButtonBuilder().setCustomId(`trivia_${message.id}_${i}`).setLabel(`Option ${i + 1}`).setStyle(ButtonStyle.Primary)
        )
      );

      const sent = await message.reply({ embeds: [embed], components: [buttons] });
      triviaState[message.id] = { correct, allAnswers, userId: message.author.id };

      const collector = sent.createMessageComponentCollector({ time: 15000 });
      collector.on('collect', async (interaction) => {
        if (interaction.user.id !== message.author.id) {
          return interaction.reply({ content: '❌ This is not your trivia question!', ephemeral: true });
        }
        const idx = parseInt(interaction.customId.split('_')[2]);
        const chosen = allAnswers[idx];
        const isCorrect = chosen === correct;

        const resultEmbed = new EmbedBuilder()
          .setColor(isCorrect ? 0x2ecc71 : 0xe74c3c)
          .setTitle(isCorrect ? '✅ Correct!' : '❌ Wrong!')
          .setDescription(isCorrect ? `Great job! The answer was **${correct}**` : `The correct answer was **${correct}**. Better luck next time!`);

        collector.stop();
        await interaction.update({ embeds: [embed, resultEmbed], components: [] });
      });

      collector.on('end', (_, reason) => {
        if (reason === 'time') sent.edit({ components: [] }).catch(() => {});
        delete triviaState[message.id];
      });

    } catch (e) {
      console.error(e);
      message.reply('❌ Trivia error. Please try again later!');
    }
    return;
  }

  // ── !meme ──────────────────────────────────────────────────────────────────
  if (command === 'meme') {
    try {
      const subreddits = ['memes', 'dankmemes', 'me_irl', 'funny', 'AdviceAnimals'];
      const subreddit = args[0] ? args[0] : subreddits[Math.floor(Math.random() * subreddits.length)];

      const res = await fetch(`https://meme-api.com/gimme/${subreddit}`);
      const data = await res.json();

      if (!data.url || data.nsfw) return message.reply('❌ Could not find a safe meme. Try a different topic!');

      const embed = new EmbedBuilder()
        .setColor(0xff4500)
        .setTitle(data.title || 'Fresh Meme 😂')
        .setURL(data.postLink)
        .setImage(data.url)
        .setFooter({ text: `👍 ${data.ups.toLocaleString()} upvotes • r/${data.subreddit}` });

      return message.reply({ embeds: [embed] });
    } catch (e) {
      console.error(e);
      return message.reply('❌ Could not fetch a meme right now. Try again later!');
    }
  }

  // ── !chat ──────────────────────────────────────────────────────────────────
  if (command === 'chat') {
    const userMsg = args.join(' ');
    if (!userMsg) return message.reply('💬 Usage: `!chat <your message>`');

    const userId = message.author.id;
    if (!chatHistories[userId]) chatHistories[userId] = [];

    const typingMsg = await message.reply('💭 Thinking...');

    try {
      const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash',
        systemInstruction: `You are a friendly and witty Discord bot assistant. Keep responses concise (under 1800 chars), conversational, and engaging. Use occasional emojis but don't overdo it. The user's name is ${message.author.username}.`,
      });

      const chat = model.startChat({ history: chatHistories[userId] });
      const result = await chat.sendMessage(userMsg);
      const reply = result.response.text();

      // Save to history
      chatHistories[userId].push({ role: 'user', parts: [{ text: userMsg }] });
      chatHistories[userId].push({ role: 'model', parts: [{ text: reply }] });

      // Cap history at 20 messages
      if (chatHistories[userId].length > 20) chatHistories[userId] = chatHistories[userId].slice(-20);

      await typingMsg.edit(reply.slice(0, 1900));
    } catch (e) {
      console.error(e);
      await typingMsg.edit('❌ AI error. Please try again!');
    }
    return;
  }

  // ── !resetchat ─────────────────────────────────────────────────────────────
  if (command === 'resetchat') {
    delete chatHistories[message.author.id];
    return message.reply('🔄 Chat history cleared! Starting fresh.');
  }

  // ── !setup (Admin only) ────────────────────────────────────────────────────
  if (command === 'setup') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('❌ You need **Administrator** permission to use setup commands.');
    }

    const sub = args[0]?.toLowerCase();

    if (sub === 'welcome') {
      const channel = message.mentions.channels.first();
      if (!channel) return message.reply('❌ Please mention a channel: `!setup welcome #channel`');
      if (!guildConfigs[message.guild.id]) guildConfigs[message.guild.id] = {};
      guildConfigs[message.guild.id].welcomeChannelId = channel.id;
      return message.reply(`✅ Welcome channel set to ${channel}!`);
    }

    if (sub === 'message') {
      const text = args.slice(1).join(' ');
      if (!text) return message.reply('❌ Provide a message: `!setup message Your welcome text here`');
      if (!guildConfigs[message.guild.id]) guildConfigs[message.guild.id] = {};
      guildConfigs[message.guild.id].welcomeMessage = text;
      return message.reply(`✅ Welcome message set to: *"${text}"*`);
    }

    if (sub === 'view') {
      const cfg = guildConfigs[message.guild.id] || {};
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('⚙️ Current Bot Config')
        .addFields(
          { name: 'Welcome Channel', value: cfg.welcomeChannelId ? `<#${cfg.welcomeChannelId}>` : 'Not set', inline: true },
          { name: 'Welcome Message', value: cfg.welcomeMessage || 'Default', inline: true },
        );
      return message.reply({ embeds: [embed] });
    }

    return message.reply('❌ Unknown setup option. Try: `!setup welcome #channel`, `!setup message <text>`, or `!setup view`');
  }
});

// ─── UTILS ────────────────────────────────────────────────────────────────────
function decodeHtml(html) {
  return html.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────
client.login(process.env.DISCORD_TOKEN);
