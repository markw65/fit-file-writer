# Change Log

All notable changes to the "@markw65/fit-file-writer" package will be documented in this file.

### 0.1.4

- Use Garmin's javascript sdk, rather than fit-file-parser, as the basis for generating our tables

  - this ensures that we support all fields
  - allowed me to add support for fields with multiple components, and to automatically substitute "preferred" fields, such as `enhanced_speed` for `speed` (under a new option, `usePreferredFields`)

- Also use Garmin's sdk as the decoder for our tests. Unfortunately, it has bugs relating to component fields. I've reported the bugs, and in the meantime checked in a patched version of their sdk which works.

### 0.1.3

- Manually add cycle_length16, because fit-file-parser doesn't include it
- Update to latest fit-file-parser to pick up some new fields
- Update various npm packages

### 0.1.2

- Add an option to disable compressed timestamps, because most 3rd party libraries for parsing FIT files don't support them.

### 0.1.1

- Add compressed timestamp support

### 0.1.0

- First package release

### 0.0.1

Initial code
