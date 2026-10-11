export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/src/test/setup.ts'],
};
