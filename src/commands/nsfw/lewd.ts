import { 
    SlashCommandBuilder, 
    ChatInputCommandInteraction, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    TextChannel,
    MessageFlags
} from 'discord.js';
import 'dotenv/config';
import axios from 'axios';
import * as cheerio from 'cheerio';

const { LEWD_COMMAND_PLACEHOLDER } = process.env;
const FLARESOLVERR_URL = 'http://flaresolverr:8191/v1';

// --- Interfaces ---
interface DoujinData {
    id: string;
    title: string;
    url: string;
    coverImage: string;
    tags: string[];
    artist: string;
    pages: string;
}

// --- Scraper Function ---
async function getRandomDoujin(): Promise<DoujinData | null> {
    try {
        const targetUrl = 'https://nhentai.net/random/';
        
        const response = await axios.post(FLARESOLVERR_URL, {
            cmd: 'request.get',
            url: targetUrl,
            maxTimeout: 60000, // 60s timeout for Flaresolverr
        });

        // 1. Validate Response
        if (!response.data.solution || response.data.status === 'error') {
            console.error('FlareSolverr Error:', response.data.message);
            return null;
        }

        const pageHtml = response.data.solution.response;
        const resolvedUrl = response.data.solution.url; // The actual URL after redirect
        const $ = cheerio.load(pageHtml);

        // 2. Extract Data safely
        // Title: often in <h1> or <h2> depending on mobile/desktop view
        let title = $('#info h1.title').text().trim();
        if (!title) title = $('title').text().replace(' » nhentai: hentai doujinshi and manga', '');

        // Cover Image: Target the specific ID #cover
        const imgElement = $('#cover img');
        let coverSrc = imgElement.attr('data-src') || imgElement.attr('src') || '';
        if (coverSrc.startsWith('//')) coverSrc = `https:${coverSrc}`;

        // Tags: .tag-container contains spans with class .name
        const tags: string[] = [];
        $('.tag-container:contains("Tags") .tags .tag .name').each((_, el) => {
            tags.push($(el).text().trim());
        });

        // Artist
        const artist = $('.tag-container:contains("Artists") .tags .tag .name').first().text().trim() || 'Unknown';

        // Page Count
        const pages = $('.tag-container:contains("Pages") .tags .tag .name').text().trim() || '??';

        // Extract ID from URL (e.g., /g/123456/)
        const idMatch = resolvedUrl.match(/\/g\/(\d+)\//);
        const id = idMatch ? idMatch[1] : 'Unknown';

        return {
            id,
            title: title || 'Unknown Title',
            url: resolvedUrl,
            coverImage: coverSrc,
            tags: tags.slice(0, 10), // Limit to 10 tags to not overflow embed
            artist,
            pages
        };

    } catch (error) {
        console.error("Error fetching doujin:", error);
        return null;
    }
}

export default {
    cooldown: 10000,
    data: new SlashCommandBuilder()
        .setName('lewd')
        .setDescription(':D')
        .setNSFW(true), // 1. UI restriction

    async execute(interaction: ChatInputCommandInteraction) {
        // 2. Runtime Safety Check (Critical for Discord TOS)
        if (interaction.channel instanceof TextChannel && !interaction.channel.nsfw) {
            await interaction.reply({ 
                content: '❌ This command can only be used in NSFW channels!', 
                flags: MessageFlags.Ephemeral
            });
            return;
        }

        await interaction.deferReply();

        const doujin = await getRandomDoujin();

        if (!doujin) {
            // Fallback if scraping fails
            await interaction.editReply(LEWD_COMMAND_PLACEHOLDER || 'Failed to fetch content.');
            return;
        }

        // 3. Create Rich Embed
        const embed = new EmbedBuilder()
            .setTitle(`[${doujin.id}] ${doujin.title}`)
            .setURL(doujin.url)
            .setColor(0xED2553) // nHentai Red Brand Color
            .addFields(
                { name: 'Artist', value: doujin.artist, inline: true },
                { name: 'Pages', value: doujin.pages, inline: true },
                { name: 'Tags', value: doujin.tags.join(', ') || 'None' }
            )
            .setFooter({ text: 'nhentai.net', iconURL: 'https://i.imgur.com/uLAimaY.png' })
            .setTimestamp();

        // Only add image if valid URL exists
        if (doujin.coverImage) {
            embed.setImage(doujin.coverImage);
        }

        // 4. Add Buttons for interaction
        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setLabel('Read on nHentai')
                    .setStyle(ButtonStyle.Link)
                    .setURL(doujin.url),
                new ButtonBuilder()
                    .setLabel('Open Cover Image')
                    .setStyle(ButtonStyle.Link)
                    .setURL(doujin.coverImage)
            );

        await interaction.editReply({ 
            embeds: [embed], 
            components: [row] 
        });
    },
};