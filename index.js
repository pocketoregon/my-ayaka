require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, REST, Routes,
  SlashCommandBuilder, InteractionType
} = require('discord.js');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});



// In-memory store
const guildConfigs = {};
const triviaState = {};
const chatHistories = {};

// ─── SLASH COMMAND DEFINITIONS ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),

  new SlashCommandBuilder()
    .setName('hello')
    .setDescription('Say hello to the bot'),

  new SlashCommandBuilder()
    .setName('bye')
    .setDescription('Say goodbye to the bot'),

  new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('Start a trivia quiz')
    .addStringOption(opt =>
      opt.setName('category')
        .setDescription('Choose a category')
        .addChoices(
          { name: 'General Knowledge', value: 'general' },
          { name: 'Science', value: 'science' },
          { name: 'History', value: 'history' },
          { name: 'Sports', value: 'sports' },
          { name: 'Geography', value: 'geography' },
          { name: 'Music', value: 'music' },
        )),

  new SlashCommandBuilder()
    .setName('meme')
    .setDescription('Get a random meme')
    .addStringOption(opt =>
      opt.setName('topic')
        .setDescription('Optional subreddit topic (e.g. dankmemes, funny)')),

  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('Chat with the AI assistant')
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('Your message')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('resetchat')
    .setDescription('Clear your chat history with the AI'),

  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Configure the bot (Admin only)')
    .addSubcommand(sub =>
      sub.setName('welcome')
        .setDescription('Set the welcome channel')
        .addChannelOption(opt =>
          opt.setName('channel').setDescription('The welcome channel').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('message')
        .setDescription('Set the welcome message')
        .addStringOption(opt =>
          opt.setName('text').setDescription('The welcome message text').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('view')
        .setDescription('View current bot configuration')),
].map(cmd => cmd.toJSON());

// ─── READY & REGISTER COMMANDS ────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅  Logged in as ${client.user.tag}`);
  client.user.setActivity('/help | AI Bot', { type: 'WATCHING' });

  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅  Slash commands registered globally!');
  } catch (err) {
    console.error('❌  Failed to register commands:', err);
  }
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
    .setDescription(cfg.welcomeMessage || 'Glad to have you here! Use `/help` to see what I can do.')
    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
    .setTimestamp();

  channel.send({ embeds: [embed] });
});

// ─── INTERACTION HANDLER ──────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── Button interactions (trivia answers) ───────────────────────────────────
  if (interaction.isButton()) {
    const [type, msgId, idx] = interaction.customId.split('_');
    if (type !== 'trivia') return;

    const state = triviaState[msgId];
    if (!state) return interaction.reply({ content: '❌ This trivia session has expired!', ephemeral: true });
    if (interaction.user.id !== state.userId) return interaction.reply({ content: '❌ This is not your trivia question!', ephemeral: true });

    const chosen = state.allAnswers[parseInt(idx)];
    const isCorrect = chosen === state.correct;

    const resultEmbed = new EmbedBuilder()
      .setColor(isCorrect ? 0x2ecc71 : 0xe74c3c)
      .setTitle(isCorrect ? '✅ Correct!' : '❌ Wrong!')
      .setDescription(isCorrect ? `Great job! The answer was **${state.correct}**` : `The correct answer was **${state.correct}**. Better luck next time!`);

    delete triviaState[msgId];
    return interaction.update({ components: [], embeds: [...interaction.message.embeds, resultEmbed] });
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /help ──────────────────────────────────────────────────────────────────
  if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🤖 Bot Commands')
      .addFields(
        { name: '👋 Greetings', value: '`/hello` — Say hello\n`/bye` — Say goodbye', inline: true },
        { name: '🧠 Trivia', value: '`/trivia` — Start a quiz\n`/trivia [category]` — Themed quiz', inline: true },
        { name: '😂 Memes', value: '`/meme` — Random meme\n`/meme [topic]` — Topic meme', inline: true },
        { name: '💬 AI Chat', value: '`/chat <message>` — Chat with AI\n`/resetchat` — Clear history', inline: true },
        { name: '⚙️ Setup (Admin)', value: '`/setup welcome #channel`\n`/setup message <text>`\n`/setup view`', inline: true },
      );
    return interaction.reply({ embeds: [embed] });
  }

  // ── /hello ─────────────────────────────────────────────────────────────────
  if (commandName === 'hello') {
    const greetings = [
      `Hey there, **${interaction.user.username}**! 👋 How's it going?`,
      `Yo **${interaction.user.username}**! 🎉 Good to see you!`,
      `Hello, **${interaction.user.username}**! 😊 Hope you're having a great day!`,
      `What's up, **${interaction.user.username}**! 🤙`,
    ];
    return interaction.reply(greetings[Math.floor(Math.random() * greetings.length)]);
  }

  // ── /bye ───────────────────────────────────────────────────────────────────
  if (commandName === 'bye') {
    return interaction.reply(`Goodbye, **${interaction.user.username}**! 👋 See you around!`);
  }

  // ── /trivia ────────────────────────────────────────────────────────────────
if (commandName === 'trivia') {
    const requestedCat = interaction.options.getString('category');
    await interaction.deferReply();

    if (!requestedCat) {
      try {
const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
          body: JSON.stringify({ model: 'google/gemma-3-4b-it:free', messages: [{ role: 'user', content: 'Generate a Genshin Impact trivia question. Respond ONLY in this exact JSON format, no extra text: {"question":"...","correct":"...","wrong":["...","...","..."]}' }] })
        });
        const aiData = await aiRes.json();
        if (!aiData.choices || !aiData.choices[0]) throw new Error(JSON.stringify(aiData));         let raw = aiData.choices[0].message.content.replace(/```json|```/g, '').trim();
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in response');
        const q = JSON.parse(jsonMatch[0]);
        const allAnswers = shuffle([q.correct, ...q.wrong]);

        const embed = new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('🧠 Genshin Impact Trivia')
          .setDescription(`**${q.question}**`)
          .addFields(allAnswers.map((ans, i) => ({ name: `Option ${i + 1}`, value: ans, inline: true })))
          .setFooter({ text: 'You have 15 seconds!' });

        const msgId = `${interaction.id}`;
        const buttons = new ActionRowBuilder().addComponents(
          allAnswers.map((_, i) =>
            new ButtonBuilder().setCustomId(`trivia_${msgId}_${i}`).setLabel(`Option ${i + 1}`).setStyle(ButtonStyle.Primary)
          )
        );
        triviaState[msgId] = { correct: q.correct, allAnswers, userId: interaction.user.id };
        const sent = await interaction.editReply({ embeds: [embed], components: [buttons] });
        setTimeout(async () => {
          if (triviaState[msgId]) { delete triviaState[msgId]; await sent.edit({ components: [] }).catch(() => {}); }
        }, 15000);
      } catch (e) {
        console.error(e);
        interaction.editReply('❌ Could not generate a Genshin trivia question. Try again!');
      }
      return;
    }

const categoryMap = { science: 17, history: 23, sports: 21, general: 9, geography: 22, music: 12 };
    const catId = categoryMap[requestedCat] || 9;
    const catName = requestedCat.charAt(0).toUpperCase() + requestedCat.slice(1);
    try {
      const res = await fetch(`https://opentdb.com/api.php?amount=1&type=multiple&category=${catId}`);
      const data = await res.json();
      if (data.response_code !== 0) return interaction.editReply('❌ Could not fetch trivia right now. Try again!');

      const q = data.results[0];
      const correct = decodeHtml(q.correct_answer);
      const allAnswers = shuffle([correct, ...q.incorrect_answers.map(decodeHtml)]);

      const embed = new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`🧠 Trivia — ${catName}`)
        .setDescription(`**${decodeHtml(q.question)}**`)
        .addFields(allAnswers.map((ans, i) => ({ name: `Option ${i + 1}`, value: ans, inline: true })))
        .setFooter({ text: `Difficulty: ${q.difficulty} • You have 15 seconds!` });

      const msgId = `${interaction.id}`;
      const buttons = new ActionRowBuilder().addComponents(
        allAnswers.map((_, i) =>
          new ButtonBuilder().setCustomId(`trivia_${msgId}_${i}`).setLabel(`Option ${i + 1}`).setStyle(ButtonStyle.Primary)
        )
      );

      triviaState[msgId] = { correct, allAnswers, userId: interaction.user.id };

      const sent = await interaction.editReply({ embeds: [embed], components: [buttons] });

      setTimeout(async () => {
        if (triviaState[msgId]) {
          delete triviaState[msgId];
          await sent.edit({ components: [] }).catch(() => {});
        }
      }, 15000);

    } catch (e) {
      console.error(e);
      interaction.editReply('❌ Trivia error. Please try again later!');
    }
    return;
  }

  // ── /meme ──────────────────────────────────────────────────────────────────
  if (commandName === 'meme') {
    await interaction.deferReply();
    try {
      const subreddits = ['Genshin_Impact', 'GenshinImpactMemes', 'GenshinMemepact'];
      const subreddit = interaction.options.getString('topic') || subreddits[Math.floor(Math.random() * subreddits.length)];

      const res = await fetch(`https://meme-api.com/gimme/${subreddit}`);
      const data = await res.json();

      if (!data.url || data.nsfw) return interaction.editReply('❌ Could not find a safe meme. Try a different topic!');

      const embed = new EmbedBuilder()
        .setColor(0xff4500)
        .setTitle(data.title || 'Fresh Meme 😂')
        .setURL(data.postLink)
        .setImage(data.url)
        .setFooter({ text: `👍 ${data.ups.toLocaleString()} upvotes • r/${data.subreddit}` });

      return interaction.editReply({ embeds: [embed] });
    } catch (e) {
      console.error(e);
      return interaction.editReply('❌ Could not fetch a meme right now. Try again later!');
    }
  }

  // ── /chat ──────────────────────────────────────────────────────────────────
  if (commandName === 'chat') {
    const userMsg = interaction.options.getString('message');
    const userId = interaction.user.id;
    if (!chatHistories[userId]) chatHistories[userId] = [];

    await interaction.deferReply();

    try {
 const messages = [
        { role: 'system', content: `You are a friendly and witty Discord bot assistant. Keep responses concise (under 1800 chars), conversational, and engaging. Use occasional emojis but don't overdo it. The user's name is ${interaction.user.username}.` },
        ...chatHistories[userId].map(m => ({ role: m.role === 'model' ? 'assistant' : 'user', content: m.parts[0].text })),
        { role: 'user', content: userMsg }
      ];
      const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENROUTER_API_KEY}` },
        body: JSON.stringify({ model: 'google/gemma-3-4b-it:free', messages })
      });
      const aiData = await aiRes.json();
      const reply = aiData.choices[0].message.content;

      chatHistories[userId].push({ role: 'user', parts: [{ text: userMsg }] });
      chatHistories[userId].push({ role: 'model', parts: [{ text: reply }] });

      if (chatHistories[userId].length > 20) chatHistories[userId] = chatHistories[userId].slice(-20);

      await interaction.editReply(reply.slice(0, 1900));
    } catch (e) {
      console.error(e);
      await interaction.editReply('❌ AI error. Please try again!');
    }
    return;
  }

  // ── /resetchat ─────────────────────────────────────────────────────────────
  if (commandName === 'resetchat') {
    delete chatHistories[interaction.user.id];
    return interaction.reply({ content: '🔄 Chat history cleared! Starting fresh.', ephemeral: true });
  }

  // ── /setup ─────────────────────────────────────────────────────────────────
  if (commandName === 'setup') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return interaction.reply({ content: '❌ You need **Administrator** permission to use setup commands.', ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'welcome') {
      const channel = interaction.options.getChannel('channel');
      if (!guildConfigs[interaction.guild.id]) guildConfigs[interaction.guild.id] = {};
      guildConfigs[interaction.guild.id].welcomeChannelId = channel.id;
      return interaction.reply({ content: `✅ Welcome channel set to ${channel}!`, ephemeral: true });
    }

    if (sub === 'message') {
      const text = interaction.options.getString('text');
      if (!guildConfigs[interaction.guild.id]) guildConfigs[interaction.guild.id] = {};
      guildConfigs[interaction.guild.id].welcomeMessage = text;
      return interaction.reply({ content: `✅ Welcome message set to: *"${text}"*`, ephemeral: true });
    }

    if (sub === 'view') {
      const cfg = guildConfigs[interaction.guild.id] || {};
      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('⚙️ Current Bot Config')
        .addFields(
          { name: 'Welcome Channel', value: cfg.welcomeChannelId ? `<#${cfg.welcomeChannelId}>` : 'Not set', inline: true },
          { name: 'Welcome Message', value: cfg.welcomeMessage || 'Default', inline: true },
        );
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }
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
