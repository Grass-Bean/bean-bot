export default {
    data: {
        name: 'fixture',
        description: 'Fixture command',
        toJSON: () => ({ name: 'fixture', description: 'Fixture command' })
    },
    execute: async () => undefined
};
