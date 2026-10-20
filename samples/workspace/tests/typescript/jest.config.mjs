// Jest runs the tests generated into jest/ as ES modules (npm run test:jest
// passes --experimental-vm-modules). The generated files carry no types, so
// they need no transform.
import path from 'node:path';

const junit = process.env.JUNIT_FILE;

export default {
  testMatch: ['<rootDir>/jest/**/*.bdd.test.ts'],
  moduleFileExtensions: ['ts', 'mjs', 'js', 'json'],
  extensionsToTreatAsEsm: ['.ts'],
  transform: {},
  // JUnit names a test by its own title and the describes around it; JUNIT_FILE (a full path) moves the report.
  reporters: ['default', ['jest-junit', {
    outputDirectory: junit ? path.dirname(junit) : 'out', outputName: junit ? path.basename(junit) : 'jest.xml',
    titleTemplate: '{title}', classNameTemplate: '{classname}', ancestorSeparator: ' > ',
  }]],
};
