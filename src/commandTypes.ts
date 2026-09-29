import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export interface BotCommand {
    data: SlashCommandBuilder;
    execute(interaction: ChatInputCommandInteraction): Promise<unknown>;
    cooldown?: number;
    hidden?: boolean;
}
