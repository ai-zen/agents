import { createRouter, createWebHistory, RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "/chat",
    component: () => import("./views/chat/index.vue"),
    meta: { title: "聊天" },
  },
  {
    path: "/agent/list",
    component: () => import("./views/agent/list/index.vue"),
    meta: { title: "智能体列表" },
  },
  {
    path: "/agent/form",
    component: () => import("./views/agent/form/index.vue"),
    meta: { title: "编辑智能体" },
  },
  {
    path: "/agent-tool/list",
    component: () => import("./views/agent-tool/list/index.vue"),
    meta: { title: "子智能体列表" },
  },
  {
    path: "/agent-tool/form",
    component: () => import("./views/agent-tool/form/index.vue"),
    meta: { title: "编辑子智能体" },
  },
  {
    path: "/tool/list",
    component: () => import("./views/tool/list/index.vue"),
    meta: { title: "工具列表" },
  },
  {
    path: "/tool/form",
    component: () => import("./views/tool/form/index.vue"),
    meta: { title: "编辑工具" },
  },
  {
    path: "/knowledge-base/list",
    component: () => import("./views/knowledge-base/list/index.vue"),
    meta: { title: "知识库列表" },
  },
  {
    path: "/knowledge-base/form",
    component: () => import("./views/knowledge-base/form/index.vue"),
    meta: { title: "编辑知识库" },
  },
  {
    path: "/knowledge-base/data",
    component: () => import("./views/knowledge-base/data/index.vue"),
    meta: { title: "录入知识库" },
  },
  {
    path: "/endpoint/list",
    component: () => import("./views/endpoint/list/index.vue"),
    meta: { title: "服务端列表" },
  },
  {
    path: "/endpoint/form",
    component: () => import("./views/endpoint/form/index.vue"),
    meta: { title: "编辑服务端" },
  },
  {
    path: "/model/list",
    component: () => import("./views/model/list/index.vue"),
    meta: { title: "模型列表" },
  },
  {
    path: "/model/form",
    component: () => import("./views/model/form/index.vue"),
    meta: { title: "编辑模型" },
  },
  {
    path: "/",
    redirect: "/chat",
  },
];

const router = createRouter({
  routes: routes,
  history: createWebHistory(),
});

router.beforeEach((to) => {
  if (typeof to.meta?.title == "string") document.title = to.meta.title;
});

export default router;
