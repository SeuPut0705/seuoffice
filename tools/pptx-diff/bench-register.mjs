// Registers bench-hooks.mjs: `node --import tsx --import ./bench-register.mjs`.
import { register } from 'node:module'

register('./bench-hooks.mjs', import.meta.url)
