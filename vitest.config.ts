import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        clearMocks: true,
        restoreMocks: true,
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json-summary', 'html'],
            reportsDirectory: 'coverage',
            include: ['src/**/*.ts'],
            exclude: [
                'src/index.ts',
                'src/deploy-commands.ts',
                'src/discord.d.ts',
                'src/audio/types.ts'
            ],
            thresholds: {
                lines: 80,
                functions: 80,
                statements: 80,
                branches: 80
            }
        }
    }
});
