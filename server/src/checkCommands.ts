/**
 * Which shell commands are tests or builds, so their outcome can be shown as
 * "tests passed" / "build failed". Only the category leaves this module; the
 * command itself is never stored or sent.
 */

export type CheckKind = 'test' | 'build';

const TEST_COMMAND =
  /(^|[\s;&|(])(vitest|jest|pytest|mocha|rspec|phpunit|(npm|pnpm|yarn|bun)( run)? test(:[\w:-]+)?|go test|cargo test|playwright test|swift test)(?=$|[\s;&|)])/;
const BUILD_COMMAND =
  /(^|[\s;&|(])((npm|pnpm|yarn|bun)( run)? build(:[\w:-]+)?|tsc|esbuild(\.m?[jt]s)?|vite build|cargo build|go build|make|gradle|mvn|xcodebuild|swift build)(?=$|[\s;&|)])/;

/** The check a command runs, if it is a test or build command (tests win). */
export function classifyCheckCommand(command: string): CheckKind | undefined {
  if (TEST_COMMAND.test(command)) return 'test';
  if (BUILD_COMMAND.test(command)) return 'build';
  return undefined;
}
