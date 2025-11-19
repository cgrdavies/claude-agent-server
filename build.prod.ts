// E2B build script

import { defaultBuildLogger, Template, waitForPort } from 'e2b'

const template = Template()
  .fromBaseImage()
  .gitClone('https://github.com/dzhng/claude-agent-server', '/app', {
    branch: 'main',
  })
  .setWorkdir('/app')
  .runCmd('bun install')
  .setStartCmd('bun index.ts', waitForPort(3000))

async function main() {
  await Template.build(template, {
    alias: 'claude-agent-server',
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  })
}

main().catch(console.error)
