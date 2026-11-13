// Every zip the gate writes stamps its entries with one fixed date instead of
// the clock, so a deck an input carries is the same bytes on every run: the
// ledger (divergences.json) finds an input by its exact arguments. JSZip takes
// `defaults.date || new Date()` for an entry or folder added without a date;
// this sets the default to the date of a zip with no clock (1980-01-01), the
// one the Rust writer stamps.
import JSZip from 'jszip'

const withDefaults = JSZip as unknown as { defaults: { date: Date | null } }
withDefaults.defaults.date = new Date(Date.UTC(1980, 0, 1))
