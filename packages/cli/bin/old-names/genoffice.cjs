// The bundle's file name before SeuOffice took its own (old-names.ts,
// OLD_CLI_BUNDLE_FILES). MCP entries an earlier version wrote on Windows run
// `SeuOffice.exe <resources>\cli\genoffice.cjs mcp`. The bundle starts only as
// the main module, so it is run as the main module, not required.
'use strict'
process.argv[1] = require('node:path').join(__dirname, 'seuoffice.cjs')
require('node:module').runMain()
