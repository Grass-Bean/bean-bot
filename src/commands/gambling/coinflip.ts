import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from 'discord.js';

import 'dotenv/config';
const {GOON_COIN_HEADS, GOON_COIN_TAILS} = process.env;
if (!GOON_COIN_HEADS||!GOON_COIN_TAILS) {
    throw new Error("Missing GOON_COIN_HEADS or GOON_COIN_TAILS in .env file");
}

export default {
    // 5 seconds (5000 ms) cooldown for this specific command
    cooldown: 5000,
    data: new SlashCommandBuilder()
        .setName('flip')
        .setDescription('Flips a coin!'),
        
    async execute(interaction: ChatInputCommandInteraction) {
        const numfaces = 2;
        const emotes: Record<string, string> = {
            'Heads': `${GOON_COIN_HEADS}`,
            'Tails': `${GOON_COIN_TAILS}`
        };
        const result = Math.floor(Math.random() * numfaces) === 0 ? 'Heads' : 'Tails';
        const emoteId = emotes[result];

        const embed = new EmbedBuilder()
            .setColor(0xFFD700) // Gold color
            .setAuthor({
                name: interaction.user.username,
                iconURL: interaction.user.displayAvatarURL(),
            })
            .setDescription(`Flipped a coin and got **${result}**`)
            .setTimestamp();
        
        embed.setThumbnail(`https://cdn.discordapp.com/emojis/${emoteId}.png`);
        

        await interaction.reply({ embeds: [embed] });
    },
};