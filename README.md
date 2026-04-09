# AI-ZEN Agents

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

## Project Introduction

**AI-ZEN Agents** is a simple LLM Agent Framework that consists of two sub-projects: `@ai-zen/agents-core` and `@ai-zen/agents-webui`. It aims to simplify the development of LLM Agent applications. Currently, the project is still in its early development stage but already provides the foundation to build fully functional LLM Agent applications.

There are still many known issues to be fixed in this project, and there are still many features that have not been implemented.

## Features

### @ai-zen/agents-core

- A Typescript library that can be used in Node.js and browser environments
- Provides encapsulations for "models", "tools," and "RAG" concepts
- Allows for easy implementation of LLM Agent applications with reusable components

### @ai-zen/agents-webui

- A Vue.js-based web application
- Showcases and interacts with LLM Agent applications
- Integrates modules for "session", "scenario", "agent", "tool", "knowledge base", and "server"
- Utilizes IndexedDB for persistent application data
- Can run independently in the browser without relying on backend services

## Installation Guide

First, make sure you have the following dependencies installed:

- Node.js 16.20+
- pnpm 8.0.0+ (or using `corepack enable` to enabled.)

Clone this repository

```
git clone https://github.com/ai-zen/chats.git
```

Run the following command to install dependencies

```
pnpm i
```

Run the following command to start the project

```
pnpm dev
```

## Documentation

This project does not currently provide documentation, but you can explore its implementation details by examining the source code.
Once the project reaches a more mature development stage, we will provide detailed documentation.

## License

This project is licensed under the MIT License. See the [LICENSE.md](LICENSE.md) file for more details.

## To Do Items

[ ] i18n  
[ ] STT input
