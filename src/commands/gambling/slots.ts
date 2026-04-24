import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction, ColorResolvable } from 'discord.js';

const WEIGHTED_SYMBOLS = [
    { symbol: '🍋', weight: 45 },  // Lemon - Most common
    { symbol: '🍒', weight: 35 },  // Cherry
    { symbol: '🍊', weight: 30 },  // Orange
    { symbol: '🔔', weight: 15 },  // Bell
    { symbol: '🍉', weight: 12 },  // Watermelon
    { symbol: '💠', weight: 10 },  // Diamond
    { symbol: '⭐', weight: 8 },   // Star
    { symbol: '🎰', weight: 6 },   // Slot Machine
    { symbol: '7️⃣', weight: 5 },   // Seven
    { symbol: '💰', weight: 3 },   // Money Bag
    { symbol: '👑', weight: 2 },   // Crown
    { symbol: '💎', weight: 1 },   // Gem (Rarest)
];

const SPIN_DURATION = 800; // Slightly slower for better effect
const SPIN_ICON = '❓';

// Helper: Wait function (promisified setTimeout)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function generateSpinningEmbed(user: any, reels: string[], revealedCount = 0) {
    const display = reels.map((s, i) => i < revealedCount ? s : SPIN_ICON);
    return new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🎰 Slot Machine Spinning...')
        .setDescription(`**[ ${display.join(' | ')} ]**`)
        .setFooter({ text: user.username, iconURL: user.displayAvatarURL() });
}

function calculateResult(reels: string[]) {
    const counts: { [key: string]: number } = {};
    for (const symbol of reels) {
        counts[symbol] = (counts[symbol] || 0) + 1;
    }

    // Get counts, sort descending (e.g., [3], [2,1], [1,1,1])
    const matches = Object.values(counts).sort((a, b) => b - a);
    const uniqueSymbols = new Set(reels).size;

    // 1. Jackpot: 3 matching rare items
    const isJackpot = matches[0] === 3 && ['💎', '👑', '7️⃣'].includes(reels[0]);
    if (isJackpot) {
        return { win: 'JACKPOT', multiplier: 50 };
    }

    // 2. Triple Match (Any 3 same)
    if (matches[0] === 3) {
        const basePayout: { [key: string]: number } = {
            '💰': 20, '🔔': 15, '💠': 10, '⭐': 8, '🎰': 7, '🍉': 5
        };
        return {
            win: 'TRIPLE',
            multiplier: basePayout[reels[0]] || 3
        };
    }

    // 3. Double Match (2 same)
    if (matches[0] === 2) {
        // Check for adjacent matches (0=1 or 1=2)
        const isAdjacent = (reels[0] === reels[1]) || (reels[1] === reels[2]);
        return {
            win: isAdjacent ? 'DOUBLE_ADJACENT' : 'DOUBLE',
            multiplier: isAdjacent ? 2 : 1
        };
    }

    // 4. Special Combo (Specific 3 different items)
    if (uniqueSymbols === 3 && ['💎', '⭐', '🔔'].every(s => reels.includes(s))) {
        return { win: 'SPECIAL_COMBO', multiplier: 5 };
    }

    return { win: 'LOSE', multiplier: 0 };
}

function getRandomSymbol() {
    const totalWeight = WEIGHTED_SYMBOLS.reduce((acc, cur) => acc + cur.weight, 0);
    const random = Math.random() * totalWeight;
    let accumulator = 0;

    for (const symbolData of WEIGHTED_SYMBOLS) {
        accumulator += symbolData.weight;
        if (random < accumulator) return symbolData.symbol;
    }
    return WEIGHTED_SYMBOLS[0].symbol;
}

function getResultMessage(resultType: string) {
    const messages: { [key: string]: string } = {
        JACKPOT: '🎉💰 JACKPOT! 💰🎉',
        TRIPLE: '🔥 Triple Match!',
        DOUBLE_ADJACENT: '🎯 Adjacent Pair!',
        DOUBLE: '🎯 Matching Pair!',
        SPECIAL_COMBO: '✨ Special Symbol Combo!',
        LOSE: '💸 Aw, dang it!'
    };
    return messages[resultType] || 'No Result';
}

const MINVAL = 1;
const DEFAULTBET = 1;

export default {
    cooldown: 10000,
    data: new SlashCommandBuilder()
        .setName('slots')
        .setDescription('Gamba!')
        .addIntegerOption(option =>
            option.setName('bet')
                .setDescription(`Amount to bet (default: ${DEFAULTBET})`)
                .setMinValue(MINVAL)
                .setRequired(false)),

    async execute(interaction: ChatInputCommandInteraction) {
        const bet = interaction.options.getInteger('bet') || DEFAULTBET;

        // 1. Generate Results Immediately
        const reels = [
            getRandomSymbol(),
            getRandomSymbol(),
            getRandomSymbol()
        ];

        // 2. Initial Reply
        let embed = generateSpinningEmbed(interaction.user, reels);
        await interaction.reply({ embeds: [embed] });
        const message = await interaction.fetchReply();

        // 3. Animations
        await wait(SPIN_DURATION);
        embed = generateSpinningEmbed(interaction.user, reels, 1);
        await message.edit({ embeds: [embed] });

        await wait(SPIN_DURATION);
        embed = generateSpinningEmbed(interaction.user, reels, 2);
        await message.edit({ embeds: [embed] });

        await wait(SPIN_DURATION);

        // 4. Final Calculation
        const result = calculateResult(reels);
        const won = bet * result.multiplier;

        const colorMap: { [key: string]: string } = {
            JACKPOT: '#FFD700',
            TRIPLE: '#00FF00',
            DOUBLE_ADJACENT: '#FFA500',
            DOUBLE: '#ADD8E6',
            SPECIAL_COMBO: '#9400D3',
            LOSE: '#FF0000'
        };

        const finalEmbed = new EmbedBuilder()
            .setColor((colorMap[result.win] || '#FFFFFF') as ColorResolvable)
            .setTitle(result.win === 'JACKPOT' ? '💰 JACKPOT 💰' : '🎰 Slot Machine Results')
            .setDescription(`**[ ${reels.join(' | ')} ]**`)
            .addFields(
                { name: 'Result', value: getResultMessage(result.win), inline: true },
                { name: 'Bet', value: `${bet}`, inline: true },
                { name: 'Won', value: `**${won}**`, inline: true }
            )
            .setFooter({ text: interaction.user.username, iconURL: interaction.user.displayAvatarURL() });

        await message.edit({ embeds: [finalEmbed] });
    }
};