module.exports = (async () => {
    const tsPlugin = await import('@typescript-eslint/eslint-plugin');
    const tsParser = await import('@typescript-eslint/parser');
    return [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tsParser.default,
        },
        plugins: {
          '@typescript-eslint': tsPlugin.default,
        },
        rules: {
          ...tsPlugin.default.configs.recommended.rules,
        },
      },
    ];
  })();