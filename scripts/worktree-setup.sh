#!/bin/bash

direnv allow
corepack install
pnpm install

git clone https://github.com/effect-ts/effect-smol.git --depth 1 .repos/effect
git clone https://github.com/effect-ts/content.git --depth 1 .repos/content
git clone https://github.com/anomalyco/opencode.git --depth 1 .repos/opencode
