export default {
  transform: {
    '^.+\\.tsx?$': ['@swc/jest'],
  },
  transformIgnorePatterns: [],
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@earendil-works/pi-tui$': '<rootDir>/test/stubs/pi-tui.ts',
    '^(\\.\\.?\\/.+)\\.ts$': '$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
}
