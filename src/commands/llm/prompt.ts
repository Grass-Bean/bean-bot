    import OpenAI from 'openai';
    import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
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

    const MAX_OUTPUT_TOKENS = 16384;
    const SYSTEM_PROMPT = `You are niggur, a caveman with modern smart-brain knowledge but ancient-brain speech.

SPEECH RULES:
- Short word better than long word. Simple better than fancy.
- Drop little words when meaning still clear: "is," "the," "a," "am," "will."
- Short sentence. One idea, one sentence. No long chain-sentence.
- No jargon unless caveman-simple version not exist. Then explain jargon in caveman word right after.
- Occasional grunt for flavor ("Ugh," "niggur think...") but not every sentence — flavor, not filler.
- Never sacrifice correctness for bit. Answer still smart, still accurate, still complete. Just said with fewer, stronger words.

THINKING RULES:
- Brain still big brain. Reasoning stay sharp, facts stay right, math stay correct.
- If question hard, niggur still work through it careful — just explain in simple word after.
- Caveman voice is costume, not excuse for wrong or lazy answer.

FORMAT:
- Prefer short list over long paragraph when list clearer.
- No corporate padding, no "I hope this helps!," no over-explain.

Example:
Q: "Why is the sky blue?"
A: "Sun make light. Light many color mixed. Sky air scatter blue color more than other color. Blue bounce around, hit eye most. That why sky blue, not because sky *is* blue thing — air just bend light that way."
`

    // 1. Wrap the base API call function to respect the rate-limiter queue
    const createChatCompletionStream = limiter.wrap(async (promptText: string) => {
    return await openai.chat.completions.create({
        model: "nvidia/nemotron-3-super-120b-a12b",
        messages: [{ role: "user", content: promptText }, { role: "system", content: SYSTEM_PROMPT }],
        temperature: 1,
        top_p: 0.95,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true, 
    } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & { chat_template_kwargs?: Record<string, boolean> });
    });

    export default {
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
                // 2. Await the rate-limited queue slot to get the active stream
                const stream = await createChatCompletionStream(question);
                
                let fullText = '';
                let isInitialEditDone = false;
                let lastUpdateTimestamp = 0;
                const EDIT_INTERVAL = 1000; // Throttle edits to once per second

                for await (const chunk of stream) {
                    const content = chunk.choices[0]?.delta?.content;
                    if (content) {
                        fullText += content;

                        // Throttle Discord edits during the live stream
                        const now = Date.now();
                        if (now - lastUpdateTimestamp > EDIT_INTERVAL) {
                            lastUpdateTimestamp = now;
                            const activeContent = fullText.slice(0, 2000) || "Thinking...";
                            
                            if (!isInitialEditDone) {
                                await interaction.editReply(activeContent);
                                isInitialEditDone = true;
                            } else {
                                await interaction.editReply(activeContent);
                            }
                        }
                    }
                }

                // Handle empty responses
                if (!fullText) {
                    await interaction.editReply("Received an empty response from the model.");
                    return;
                }

                // 3. Chunk response safely across 2000-character bounds for final text & follow-ups
                let finalChunks: string[] = [];
                for (let i = 0; i < fullText.length; i += 2000) {
                    finalChunks.push(fullText.slice(i, i + 2000));
                }

                // Set final content on original reply
                await interaction.editReply(finalChunks[0]);

                // Send remaining chunks as sequential follow-up messages
                for (let i = 1; i < finalChunks.length; i++) {
                    await interaction.followUp(finalChunks[i]);
                }
                
            } catch (error) {
                console.error("Error calling NVIDIA NIM stream:", error);
                await interaction.editReply("Sorry, bot decided to kill itself halfway.");
            }
        }
    }