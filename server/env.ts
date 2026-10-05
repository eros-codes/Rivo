// Loads .env before anything else reads process.env. server/index.ts imports
// this module first: ES modules evaluate their imports in order, so every
// module that reads configuration at import time (push keys, limits) sees
// the values from .env.
import dotenv from "dotenv";

dotenv.config();
