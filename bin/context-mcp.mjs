#!/usr/bin/env node

import { tsImport } from "tsx/esm/api";

await tsImport("../src/index.ts", import.meta.url);
