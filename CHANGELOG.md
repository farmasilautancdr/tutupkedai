# Changelog

## v2.19 - 2026-09-07

### Added
- Google Sheet export now splits each outlet's data into one tab per calendar month (e.g. "Aug 2026", "Sep 2026"), auto-created as new months of receipts arrive.
- Month tabs are auto-removed once their month no longer has any matching data (e.g. after an outlet's history is reset), so tabs don't pile up stale. Tabs not created by this export (a manually added sheet, an old flat all-history sheet) are never touched.

### Fixed
- The Daily Summary row in the exported Sheet is now a real merged cell spanning the full row, instead of just text overflowing over blank neighboring cells.
