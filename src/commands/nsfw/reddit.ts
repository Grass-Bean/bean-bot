import { 
    SlashCommandBuilder, 
    ChatInputCommandInteraction, 
    TextChannel,
    MessageFlags
} from 'discord.js';
import snoowrap from 'snoowrap';
import 'dotenv/config';
const {DEFAULT_SUBREDDITS, REDDIT_CLIENT_ID, REDDIT_SECRET_TOKEN, REDDIT_REFRESH_TOKEN} = process.env;
if (!DEFAULT_SUBREDDITS) {
    throw new Error("Missing DEFAULT_SUBREDDITS in .env file");
}
if (!REDDIT_CLIENT_ID || !REDDIT_SECRET_TOKEN || !REDDIT_REFRESH_TOKEN) {
    throw new Error("Missing Reddit API credentials in .env file");
}

// --- Interfaces ---
interface RedditPost {
    link: string;
    text: string;
    score: number;
    nsfw: boolean;
    subreddit: string;
}

const MAXVAL = 500;
const MINVAL = 10;
const DEFAULTVAL = 150;
const DEFAULT_SORT = 'hot';

export default {
    data: new SlashCommandBuilder()
        .setName('reddit')
        .setNSFW(true)
        .setDescription('Gets random reddit post with media (defaults: ZZZ_Official, WutheringWaves, HonkaiStarRail).')
        .addBooleanOption(option =>
            option.setName('nsfw')
                .setDescription('Whether to include NSFW posts (default: true)')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('subreddits')
                .setDescription('Optional comma-separated subreddits')
                .setRequired(false))
        .addStringOption(option =>
            option.setName('sort')
                .setDescription('Sorting method (default: hot)')
                .addChoices(
                    { name: 'Hot', value: 'hot' },
                    { name: 'New', value: 'new' },
                    { name: 'Top', value: 'top' }
                )
                .setRequired(false))
        .addIntegerOption(option =>
            option.setName('limit')
                .setDescription(`Posts per subreddit (default: ${DEFAULTVAL}. min: ${MINVAL}. max: ${MAXVAL})`)
                .setMinValue(MINVAL)
                .setMaxValue(MAXVAL)
                .setRequired(false)),
    
    async execute(interaction: ChatInputCommandInteraction) {
        if (interaction.channel instanceof TextChannel && !interaction.channel.nsfw) {
            await interaction.reply({ 
                content: '❌ This command can only be used in NSFW channels!', 
                flags: MessageFlags.Ephemeral
            });
            return;
        }
        await interaction.deferReply();

        try {
            // Get options
            const subredditInput = interaction.options.getString('subreddits');
            const subreddits = subredditInput 
                ? subredditInput.split(',').map(s => s.trim().replace('r/', ''))
                : DEFAULT_SUBREDDITS.split(',').map(s => s.trim().replace('r/', ''));
            
            if (!Array.isArray(subreddits) || subreddits.length === 0) {
                await interaction.editReply('❌ Please provide at least one valid subreddit');
                return;
            }

            const sortMethod = interaction.options.getString('sort') || DEFAULT_SORT;
            const postLimit = interaction.options.getInteger('limit') || MAXVAL;
            const includeNSFW = interaction.options.getBoolean('nsfw') ?? true;
            // Get posts
            const allPosts = await searchMultipleSubreddits(subreddits, sortMethod, postLimit, includeNSFW);
            
            if (allPosts.length === 0) {
                await interaction.editReply('No media posts found in specified subreddits 😢');
                return;
            }
            
            // Select random post
            const randomPost = allPosts[Math.floor(Math.random() * allPosts.length)];
            const response = [
                `**From r/${randomPost.subreddit}**`,
                `**${randomPost.text}**`,
                `Score: ⬆️ ${randomPost.score}`,
                `Link: ${randomPost.link}`
            ].join('\n');

            await interaction.editReply(response);

        } catch (error) {
            console.error(error);
            await interaction.editReply('Failed to fetch posts 😢');
        }
    }
};

async function searchMultipleSubreddits(subreddits: string[], sort = DEFAULT_SORT, limit = DEFAULTVAL, includeNSFW: boolean): Promise<RedditPost[]> {
    const r = new snoowrap({
        userAgent: 'GoonBot/1.0 (by YOUR_REDDIT_USERNAME)',
        clientId: REDDIT_CLIENT_ID,
        clientSecret: REDDIT_SECRET_TOKEN,
        refreshToken: REDDIT_REFRESH_TOKEN
    });

    try {
        console.log(`Searching ${subreddits.join('+')}`);
        
        const multiSub = r.getSubreddit(subreddits.join('+'));

        let posts: any; // Using 'any' for Snoowrap response to simplify Mapping below

        switch(sort.toLowerCase()) {
            case 'new':
                posts = await multiSub.getNew({ limit });
                break;
            case 'top':
                posts = await multiSub.getTop({ time: 'week', limit });
                break;
            default:
                posts = await multiSub.getHot({ limit });
        }
        
        const mediaRegex = /\.(jpe?g|png|gif|webp|mp4|mov|avi|webm)$/i;

        // Map and Filter
        return posts
            .map((post: any) => ({
                link: post.url,
                text: post.title,
                score: post.score,
                nsfw: post.over_18,
                subreddit: post.subreddit.display_name
            }))
            .filter((post: RedditPost) => mediaRegex.test(post.link) && includeNSFW ? true : !post.nsfw);

    } catch (error) {
        console.error('Reddit API Error:', error);
        throw new Error('Failed to search subreddits');
    }
}