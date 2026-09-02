import OpenAI from 'openai';
import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel } from 'discord.js';
const { NVIDIA_API_KEY } = process.env;
const openai = new OpenAI({
  apiKey: NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
})
import Bottleneck from 'bottleneck';

// Rate limiter: 20 RPM, min 3 seconds spacing, 1 concurrent execution
const limiter = new Bottleneck({
  reservoir: 20, 
  reservoirRefreshAmount: 20, 
  reservoirRefreshInterval: 60 * 1000, 
  minTime: 3000,
  maxConcurrent: 1 
});

// Set your desired token output limit here
const MAX_OUTPUT_TOKENS = 500; // ~1,800 to 2,000 characters (Discord message size)

const prompt = limiter.wrap(async (promptText: string): Promise<string> => {
  const completion = await openai.chat.completions.create({
    model: "nvidia/nemotron-3-super-120b-a12b",
    messages: [{ role: "user", content: promptText }],
    temperature: 1,
    top_p: 0.95,
    max_tokens: MAX_OUTPUT_TOKENS, // Updated from 16384
    stream: false, 
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { chat_template_kwargs?: Record<string, boolean> });

  const message = completion.choices[0]?.message as OpenAI.Chat.Completions.ChatCompletionMessage & { 
    reasoning_content?: string | null 
  };
  
  return message?.content || "";
});

export default {
    // 10 seconds (10000 ms) cooldown for this specific command
    cooldown: 10000,
    data: new SlashCommandBuilder()
        .setName('prompt')
        .setDescription('Prompts the LLM with a question')
        .addStringOption(option =>
            option.setName('question')
                .setDescription('The question to ask the LLM')
                .setRequired(true)),
    async execute(interaction: ChatInputCommandInteraction) {
        const question = interaction.options.getString('question', true);
        await interaction.deferReply();
        try {
            const response = await prompt(question);
            
            // Discord has a strict 2000 character limit per message.
            // Truncate the response to avoid a 50035 error on large outputs.
            const safeResponse = response.length > 2000 
                ? response.slice(0, 1997) + '...' 
                : response;
            
            await interaction.editReply(safeResponse);
            
        } catch (error) {
            console.error("Error calling NVIDIA NIM:", error);
            await interaction.editReply("Sorry, my token probably expired or bot got rate limited. Please try again never.");
        }
    }
}