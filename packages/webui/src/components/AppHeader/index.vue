<template>
  <div class="app-header">
    <div class="logo">CHATS</div>
    <div class="nav">
      <RouterLink to="/chat">聊天</RouterLink>
      <RouterLink to="/agent/list">智能体</RouterLink>
      <RouterLink to="/agent-tool/list">子智能体</RouterLink>
      <RouterLink to="/tool/list">工具</RouterLink>
      <RouterLink to="/knowledge-base/list">知识库</RouterLink>
      <RouterLink to="/model/list">模型</RouterLink>
      <RouterLink to="/endpoint/list">服务端</RouterLink>
    </div>
    <div class="user">
      <div class="avatar">A</div>
      <div class="name">Hi, 测试用户</div>
    </div>
  </div>
</template>

<script setup lang="ts"></script>

<style lang="scss" scoped>
.app-header {
  height: 50px;
  display: flex;
  align-items: center;
  background-color: var(--el-bg-color);
  position: relative;
  z-index: 3;
  // border-bottom: var(--el-border);
  box-shadow: var(--el-box-shadow-light);

  .logo {
    font-weight: bold;
    margin: 0 30px;
    color: var(--el-text-color-primary);
    font-size: 16px;
  }
  .nav {
    display: flex;
    align-items: center;
    a {
      display: block;
      color: var(--el-text-color-regular);
      margin: 0 12px;
      text-decoration: none;
      font-size: 14px;
      &.router-link-active {
        color: var(--el-color-primary);
        font-weight: bold;
      }
    }
  }
  .user {
    margin-left: auto;
    margin-right: 30px;
    display: flex;
    align-items: center;
    .avatar {
      width: 36px;
      height: 36px;
      background-color: var(--el-fill-color);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: bold;
      color: var(--el-text-color-placeholder);
    }
    .name {
      font-size: 14px;
      margin-left: 1em;
    }
  }
}
</style>
