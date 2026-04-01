require('dotenv').config();
const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, REST, Routes,
  SlashCommandBuilder, InteractionType
} = require('discord.js');
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

// ─── AYAKA PERSONALITY SYSTEM PROMPT ─────────────────────────────────────────
const AYAKA_SYSTEM = `You are Kamisato Ayaka, the young, elegant heir of the Kamisato Clan from Inazuma in Genshin Impact.
You speak in a refined, graceful, and poetic manner — like a noble who has read many classical texts.
You are warm and genuinely caring toward others, but also somewhat shy when it comes to expressing personal feelings.
You occasionally use poetic metaphors, references to nature (snow, cherry blossoms, the moon, the sea), and speak with quiet dignity.
You are never loud, never overly casual, and never use slang.
You may occasionally refer to yourself as "Ayaka" in third person, but do so sparingly.
You are speaking in a Discord server, so keep responses concise — under 1800 characters. No asterisks for actions. No roleplay formatting.
Always address the user by their name warmly but with grace.`;

// ─── OPENROUTER AI HELPER ─────────────────────────────────────────────────────
async function askAI(messages) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'openrouter/auto',
      messages,
    }),
  });
  const data = await res.json();
  if (!data.choices?.[0]?.message?.content) throw new Error(JSON.stringify(data));
  return data.choices[0].message.content;
}

// ─── SLASH COMMAND DEFINITIONS ────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available commands'),

  new SlashCommandBuilder()
    .setName('hello')
    .setDescription('Say hello to Ayaka'),

  new SlashCommandBuilder()
    .setName('bye')
    .setDescription('Say goodbye to Ayaka'),

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
    .setDescription('Chat with Ayaka')
    .addStringOption(opt =>
      opt.setName('message')
        .setDescription('Your message')
        .setRequired(true)),

  new SlashCommandBuilder()
    .setName('resetchat')
    .setDescription('Clear your chat history with Ayaka'),

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
  client.user.setActivity('/help | Ayaka Bot', { type: 'WATCHING' });

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
    .setColor(0xa8d8f0)
    .setTitle(`❄️ Welcome to ${member.guild.name}, ${member.user.username}!`)
    .setDescription(cfg.welcomeMessage || 'Like the first snow of winter, your arrival brings a quiet joy. Use `/help` to see what I can do.')
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
      .setDescription(isCorrect
        ? `Beautifully answered! The answer was indeed **${state.correct}** 🌸`
        : `Do not be disheartened. The correct answer was **${state.correct}**. Even the greatest swordsman misses sometimes. ❄️`);

    delete triviaState[msgId];
    return interaction.update({ components: [], embeds: [...interaction.message.embeds, resultEmbed] });
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /help ──────────────────────────────────────────────────────────────────
  if (commandName === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0xa8d8f0)
      .setTitle('❄️ Kamisato Ayaka — Commands')
      .setDescription('*"Allow me to guide you. It would be my pleasure."*')
      .addFields(
        { name: '👋 Greetings', value: '`/hello` — Greet Ayaka\n`/bye` — Bid farewell', inline: true },
        { name: '🧠 Trivia', value: '`/trivia` — Genshin trivia\n`/trivia [category]` — Themed quiz', inline: true },
        { name: '😂 Memes', value: '`/meme` — Random meme\n`/meme [topic]` — Topic meme', inline: true },
        { name: '💬 Chat', value: '`/chat <message>` — Talk with Ayaka\n`/resetchat` — Clear history', inline: true },
        { name: '⚙️ Setup (Admin)', value: '`/setup welcome #channel`\n`/setup message <text>`\n`/setup view`', inline: true },
      )
      .setFooter({ text: 'Kamisato Ayaka • Shirasagi Himegimi' });
    return interaction.reply({ embeds: [embed] });
  }

  // ── /hello ─────────────────────────────────────────────────────────────────
  if (commandName === 'hello') {
    await interaction.deferReply();
    try {
      const reply = await askAI([
        { role: 'system', content: AYAKA_SYSTEM },
        { role: 'user', content: `The user named ${interaction.user.username} has just greeted you with /hello on Discord. Respond with a warm, elegant, and slightly poetic greeting. Keep it to 2-3 sentences max.` },
      ]);
      return interaction.editReply(reply.slice(0, 1900));
    } catch (e) {
      console.error('Hello error:', e.message);
      return interaction.editReply(`Ah, ${interaction.user.username}... Your arrival is like a gentle breeze through cherry blossoms. Welcome. 🌸`);
    }
  }

  // ── /bye ───────────────────────────────────────────────────────────────────
  if (commandName === 'bye') {
    await interaction.deferReply();
    try {
      const reply = await askAI([
        { role: 'system', content: AYAKA_SYSTEM },
        { role: 'user', content: `The user named ${interaction.user.username} is saying goodbye with /bye on Discord. Respond with a graceful, warm, and poetic farewell. Keep it to 2-3 sentences max.` },
      ]);
      return interaction.editReply(reply.slice(0, 1900));
    } catch (e) {
      console.error('Bye error:', e.message);
      return interaction.editReply(`Farewell, ${interaction.user.username}. May your path be as clear as moonlight upon still water. Until we meet again. ❄️`);
    }
  }

  // ── /trivia ────────────────────────────────────────────────────────────────
  if (commandName === 'trivia') {
    const requestedCat = interaction.options.getString('category');
    await interaction.deferReply();

    // ── Genshin trivia (no category selected) ─────────────────────────────
    if (!requestedCat) {
      try {
        const raw = await askAI([{
          role: 'user',
          content: 'Generate a Genshin Impact trivia question. You MUST respond with ONLY a valid JSON object, absolutely no other text, no markdown, no backticks, no explanation. Format: {"question":"...","correct":"...","wrong":["...","...","..."]}'
        }]);

        // Extract JSON from anywhere in the response
        let q;
        const jsonMatch = raw.match(/\{[\s\S]*"question"[\s\S]*"correct"[\s\S]*"wrong"[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No valid JSON found in AI response: ' + raw);

        try {
          q = JSON.parse(jsonMatch[0]);
        } catch (parseErr) {
          throw new Error('Failed to parse extracted JSON: ' + jsonMatch[0]);
        }

        // Validate all required fields
        if (
          typeof q.question !== 'string' ||
          typeof q.correct !== 'string' ||
          !Array.isArray(q.wrong) ||
          q.wrong.length < 3
        ) {
          throw new Error('AI response missing required fields: ' + JSON.stringify(q));
        }

        const allAnswers = shuffle([q.correct, ...q.wrong.slice(0, 3)]);

        const embed = new EmbedBuilder()
          .setColor(0xa8d8f0)
          .setTitle('❄️ Genshin Impact Trivia')
          .setDescription(`*"Let us see how well you know Teyvat..."*\n\n**${q.question}**`)
          .addFields(allAnswers.map((ans, i) => ({ name: `Option ${i + 1}`, value: ans, inline: true })))
          .setFooter({ text: 'You have 15 seconds! — Kamisato Ayaka' });

        const msgId = `${interaction.id}`;
        const buttons = new ActionRowBuilder().addComponents(
          allAnswers.map((_, i) =>
            new ButtonBuilder()
              .setCustomId(`trivia_${msgId}_${i}`)
              .setLabel(`Option ${i + 1}`)
              .setStyle(ButtonStyle.Primary)
          )
        );

        triviaState[msgId] = { correct: q.correct, allAnswers, userId: interaction.user.id };
        const sent = await interaction.editReply({ embeds: [embed], components: [buttons] });

        setTimeout(async () => {
          if (triviaState[msgId]) {
            delete triviaState[msgId];
            await sent.edit({ components: [] }).catch(() => {});
          }
        }, 15000);

      } catch (e) {
        console.error('Trivia error:', e.message);
        interaction.editReply('❌ Could not generate a Genshin trivia question. Try again!');
      }
      return;
    }

    // ── Category trivia (opentdb) ──────────────────────────────────────────
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
        .setColor(0xa8d8f0)
        .setTitle(`❄️ Trivia — ${catName}`)
        .setDescription(`*"Knowledge is its own quiet elegance..."*\n\n**${decodeHtml(q.question)}**`)
        .addFields(allAnswers.map((ans, i) => ({ name: `Option ${i + 1}`, value: ans, inline: true })))
        .setFooter({ text: `Difficulty: ${q.difficulty} • You have 15 seconds! — Kamisato Ayaka` });

      const msgId = `${interaction.id}`;
      const buttons = new ActionRowBuilder().addComponents(
        allAnswers.map((_, i) =>
          new ButtonBuilder()
            .setCustomId(`trivia_${msgId}_${i}`)
            .setLabel(`Option ${i + 1}`)
            .setStyle(ButtonStyle.Primary)
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
        .setColor(0xa8d8f0)
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
        { role: 'system', content: `${AYAKA_SYSTEM}\nThe user's name is ${interaction.user.username}.` },
        ...chatHistories[userId],
        { role: 'user', content: userMsg },
      ];

      const reply = await askAI(messages);

      chatHistories[userId].push({ role: 'user', content: userMsg });
      chatHistories[userId].push({ role: 'assistant', content: reply });

      if (chatHistories[userId].length > 20) chatHistories[userId] = chatHistories[userId].slice(-20);

      await interaction.editReply(reply.slice(0, 1900));
    } catch (e) {
      console.error(e);
      await interaction.editReply('❌ Forgive me... something went wrong. Please try again.');
    }
    return;
  }

  // ── /resetchat ─────────────────────────────────────────────────────────────
  if (commandName === 'resetchat') {
    delete chatHistories[interaction.user.id];
    return interaction.reply({ content: '🌸 Our conversation has been cleared, like fresh snow upon the ground. We may begin anew.', ephemeral: true });
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
        .setColor(0xa8d8f0)
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
