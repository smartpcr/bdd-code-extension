module.exports = {
  testMatch: ['<rootDir>/jest/**/*.test.js'],
  globalSetup: '<rootDir>/jest/globalSetup.js',
  reporters: ['default', ['jest-junit', { outputDirectory: 'out', outputName: process.env.JUNIT_NAME || 'jest.xml' }]],
};
