import { SlashCommandBuilder, ChatInputCommandInteraction, TextChannel } from 'discord.js';
import { createAudioResource, AudioPlayerStatus, StreamType, AudioResource, AudioPlayer } from '@discordjs/voice';
import { spawn } from 'child_process'; 
import { promisify } from 'util';
import { AudioData, GuildVC } from '../../utility/guildvc.js';
import { joinVoiceChannel } from '../../utility/joinvoice.js';
import path from 'path';

const ELEVATOR_MUSIC_PATH = path.join(process.cwd(), 'assets', 'elevator.mp3');

async function getVideoMetaData(query: string): Promise<AudioData> {
    const isUrl = query.startsWith('http');
    const input = isUrl ? query : `ytsearch1:${query}`;

    return new Promise((resolve, reject) => {
        // Using spawn instead of exec to avoid maxBuffer crashes on large JSON payloads
        const ytProcess = spawn('yt-dlp', [
            '--dump-json',
            '--no-playlist',
            '-q',
            input
        ]);

        let stdoutData = '';
        let stderrData = '';

        // Collect data streams
        ytProcess.stdout.on('data', (chunk) => { stdoutData += chunk.toString(); });
        ytProcess.stderr.on('data', (chunk) => { stderrData += chunk.toString(); });

        ytProcess.on('close', (code) => {
            if (code !== 0) {
                // Log the ACTUAL error from YouTube/yt-dlp so you know why it failed
                console.error(`[yt-dlp Error] Code ${code}:`, stderrData.trim());
                return reject(new Error(`Failed to fetch metadata: ${stderrData.split('\n')[0] || 'Unknown error'}`));
            }

            try {
                const data = JSON.parse(stdoutData);
                resolve({
                    title: data.title,
                    url: data.webpage_url,
                    duration: data.duration_string,
                    thumbnail: data.thumbnail
                });
            } catch (err) {
                console.error('[yt-dlp Parse Error] Failed to parse JSON:', err);
                reject(new Error('Received invalid data from YouTube.'));
            }
        });

        ytProcess.on('error', (err) => {
            console.error('[yt-dlp Spawn Error]', err);
            reject(err);
        });
    });
}

async function createAudioResourceFromYTDLP(url: string): Promise<AudioResource> {
    const ytProcess = spawn('yt-dlp', [
        '-f', 'bestaudio/best',      
        '--no-playlist',        
        '-o', '-',              
        '-q', 
        // Adding a user-agent can sometimes help delay rate-limiting
        '--add-header', 'User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--extractor-args', 'youtube:player_client=default',
        url
    ]);

    ytProcess.stderr.on('data', (data) => {
        const msg = data.toString();
        if (msg.includes('Broken pipe') || msg.includes('Errno 32')) return; 
        if (!msg.includes('WARNING')) console.warn(`yt-dlp stderr: ${msg}`); 
    });

    const resource = createAudioResource(ytProcess.stdout, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true 
    });

    // Hardened cleanup to strictly prevent memory leaks and zombie processes
    const cleanup = () => {
        if (!ytProcess.killed) {
            ytProcess.kill('SIGKILL'); // Force kill if standard SIGTERM hangs
        }
    };

    ytProcess.stdout.on('close', cleanup);
    ytProcess.on('error', cleanup);
    
    // @ts-ignore
    resource.playStream.on('close', cleanup);
    resource.playStream.on('error', cleanup); // Added error listener on the stream itself

    return resource;
}

async function preloadNextSong(guildId: string) {
    const audioQueue = GuildVC.getAudioQueue(guildId);
    // @ts-ignore
    const items: AudioData[] = audioQueue.toArray ? audioQueue.toArray() : Array.from(audioQueue);
    
    // If there's less than 2 items (index 0 is playing, index 1 is next), nothing to preload
    if (items.length < 2) {
        GuildVC.clearPreload(guildId);
        return;
    }

    const nextSong = items[1];
    if (GuildVC.getPreload(guildId)) return;
    
    const resourcePromise = createAudioResourceFromYTDLP(nextSong.url)
        .catch(err => {
            console.error("Preload failed:", err);
            GuildVC.clearPreload(guildId);
            throw err;
        });

    GuildVC.setPreload(guildId, resourcePromise);
}

// Added popPrevious parameter. If false, we just read the front of the queue without discarding it.
async function playNextSong(guildId: string, player: AudioPlayer, channel: TextChannel | null, popPrevious: boolean) {
    const audioQueue = GuildVC.getAudioQueue(guildId);
    
    // Discard the song that just finished
    if (popPrevious && audioQueue.size() > 0) {
        audioQueue.popFront(); 
    }
    
    const nextSong = audioQueue.peekFront();

    if (nextSong) {
        GuildVC.setElevatorStatus(guildId, false);
        GuildVC.clearInactivityTimer(guildId);

        try {
            let resource: AudioResource;
            const preload = GuildVC.getPreload(guildId);
            
            if (preload) {
                resource = await preload;
                GuildVC.clearPreload(guildId);
            } else {
                resource = await createAudioResourceFromYTDLP(nextSong.url);
            }
            
            player.play(resource);
            if (channel) channel.send(`🎶 **Now Playing:** ${nextSong.title}\n🔗 ${nextSong.url}`);
            preloadNextSong(guildId);

        } catch (error) {
            console.error("Error playing next song:", error);
            GuildVC.clearPreload(guildId);
            if (channel) channel.send("⚠️ Could not play next song. Skipping...");
            // Force skip to the next track if this one fails
            playNextSong(guildId, player, channel, true); 
        }
    } else {
        // Queue is empty: Play elevator music and start timer
        GuildVC.setElevatorStatus(guildId, true);
        
        try {
            const elevatorResource = createAudioResource(ELEVATOR_MUSIC_PATH, { inlineVolume: true });
            if (elevatorResource.volume) elevatorResource.volume.setVolume(0.5);
            player.play(elevatorResource);
        } catch (err) {
            console.error("Failed to play elevator music:", err);
        }

        if (!GuildVC.hasInactivityTimer(guildId)) {
            if (channel) channel.send("**Queue finished.** Disconnecting in 5 minutes...");
            
            GuildVC.startInactivityTimer(guildId, 5 * 60 * 1000, () => {
                const conn = GuildVC.getConnection(guildId);
                if (conn) {
                    GuildVC.clearPreload(guildId);
                    if (channel) channel.send("**Disconnected due to 5 minutes of inactivity.**");
                    GuildVC.disconnect(guildId);
                }
            });
        }
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Plays audio from YouTube')
        .addStringOption(option => 
            option.setName('query')
                .setDescription('URL or song name')
                .setRequired(true)
        ),
        
    async execute(interaction: ChatInputCommandInteraction) {
        const guildId = interaction.guildId!;
        const conn = await joinVoiceChannel(interaction);
        if (!conn) return;

        let query = interaction.options.getString('query', true); 

        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply();
        }

        try {
            const player = GuildVC.getAudioPlayer(guildId);
            if (!player) return interaction.editReply("Player initialization failed.");
            
            conn.subscribe(player);

            const audiodata = await getVideoMetaData(query);
            audiodata.requestedBy = interaction.user.id;
            
            const audioQueue = GuildVC.getAudioQueue(guildId);
            audioQueue.pushBack(audiodata);

            const isIdle = player.state.status === AudioPlayerStatus.Idle;
            const isElevator = GuildVC.isElevatorPlaying(guildId);

            // Ensure our Idle listener is attached exactly once.
            // This listener acts as our automatic queue advancer.
            if (player.listenerCount(AudioPlayerStatus.Idle) === 0) {
                player.on(AudioPlayerStatus.Idle, () => {
                    // If elevator music finished (or was stopped), we DON'T want to pop the queue,
                    // because the elevator track wasn't in the queue to begin with.
                    const wasElevator = GuildVC.isElevatorPlaying(guildId);
                    playNextSong(guildId, player, interaction.channel as TextChannel, !wasElevator);
                });
            }

            if (isIdle) {
                // Nothing is playing at all. Kickstart the queue.
                playNextSong(guildId, player, interaction.channel as TextChannel, false);
                await interaction.editReply(`✅ **Added to queue:** ${audiodata.title}`);
            } else if (isElevator) {
                // IMPORTANT: Calling player.stop() immediately forces the player into the 'Idle' state.
                // This triggers the event listener above, which automatically reads from the queue
                // and plays the new song smoothly without any duplicate logic!
                player.stop(); 
                await interaction.editReply(`✅ **Added to queue:** ${audiodata.title}`);
            } else {
                // A normal song is already playing. It will finish naturally and trigger the Idle event.
                const pos = audioQueue.size(); 
                await interaction.editReply(`✅ **Queued:** ${audiodata.title} \n📊 Position: ${pos - 1}`);
            }

            preloadNextSong(guildId);

        } catch (error) {
            console.error(error);
            await interaction.editReply('Failed to find or play video!');
        }
    }
}