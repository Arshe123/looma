module.exports = {
  root: true,
  env: {
    browser: true,
    node: true,
    es2022: true,
  },
  parser: 'vue-eslint-parser',
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
    parser: '@typescript-eslint/parser',
  },
  plugins: ['vue', '@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:vue/vue3-essential',
    'plugin:@typescript-eslint/recommended',
  ],
  ignorePatterns: [
    'node_modules',
    'dist',
    'dist-electron',
    'build',
    'rag-service',
    '.venv',
    '**/__pycache__',
    '*.d.ts',
  ],
  rules: {
    // 项目 tsconfig 为非严格模式，保持 lint 与类型检查一致
    '@typescript-eslint/no-explicit-any': 'off',
    // .ts 文件的未使用变量（TS scope 分析更准）
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    'no-unused-vars': 'off',
    'vue/multi-word-component-names': 'off',
    // 空 catch 吞异常是项目惯用模式；非 catch 空块仍报错
    'no-empty': ['error', { allowEmptyCatch: true }],
    // while(true) 流式读取是项目惯用模式；if 等条件的常量判断仍报错
    'no-constant-condition': ['error', { checkLoops: false }],
    // TS 项目由编译器检查未定义标识符，no-undef 会误报 DOM/TS 类型
    'no-undef': 'off',
  },
  overrides: [
    {
      // Vue 单文件组件：模板中使用的变量对 TS scope 不可见，
      // 交给 core no-unused-vars + vue/script-setup-uses-vars 处理（了解模板引用）
      files: ['**/*.vue'],
      rules: {
        '@typescript-eslint/no-unused-vars': 'off',
        // args: none —— Vue 模板事件回调/emit 类型签名的参数常为占位符，不检查参数
        'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
        'vue/script-setup-uses-vars': 'error',
      },
    },
    {
      files: ['**/*.test.ts', '**/test/**/*.ts', 'scripts/test/**/*.ts'],
      globals: {
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        vi: 'readonly',
      },
    },
  ],
}
