<template>
  <div class="list-page">
    <el-page-header content="子智能体列表" @back="$router.back()">
      <template #extra>
        <el-button plain type="success" @click="create">
          <el-icon><Plus /></el-icon>&ensp; 新增子智能体
        </el-button>
      </template>
    </el-page-header>

    <el-row class="search-row">
      <el-input
        class="search-input"
        clearable
        v-model="filterState.form.keyword"
        size="large"
        placeholder="输入关键字搜索..."
        :prefix-icon="Search"
      ></el-input>
      <el-button class="search-button" type="primary" round size="large"
        >搜索</el-button
      >
    </el-row>

    <div class="card-list" v-loading="listState.isLoading">
      <div v-if="!filterList?.length && !listState.isLoading" class="empty">
        <el-empty></el-empty>
      </div>

      <div class="card" v-for="(item, index) of filterList" :key="index">
        <div class="title-row">
          <AutoIcon class="icon" :icon="item.icon"></AutoIcon>
          <div class="title">{{ item.title }}</div>
          <div class="operation">
            <el-button
              plain
              circle
              size="small"
              type="primary"
              @click="edit(item.id)"
            >
              <el-icon><Edit /></el-icon>
            </el-button>
            <el-button
              plain
              circle
              size="small"
              type="danger"
              @click="del(item.id)"
            >
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <!-- <el-row>
      <el-pagination
        :total="listState.total"
        v-model:current-page="listState.currentPage"
      ></el-pagination>
    </el-row> -->
  </div>
</template>

<script setup lang="ts">
import { Delete, Edit, Plus, Search } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { computed, onMounted, reactive } from "vue";
import { useRouter } from "vue-router";
import * as api from "../../../api";
import AutoIcon from "../../../components/AutoIcon/index.vue";
import { ChatPL } from "../../../types/ChatPL";
import { FormMode } from "../../../types/Common";

const router = useRouter();

const filterState = reactive({
  form: {
    keyword: "",
  },
});

const filterList = computed(() =>
  listState.list.filter((item) =>
    item.title.includes(filterState.form.keyword),
  ),
);

const listState = reactive({
  list: [] as ChatPL.AgentPO[],
  isLoading: false,
  isReady: false,
  // currentPage: 1,
  // pageSize: 30,
  // pageSizes: [30],
  // total: 0,
});

async function getList() {
  try {
    listState.isLoading = true;
    listState.list = await api.getAgentToolList();
    listState.isReady = true;
  } catch (error: any) {
    ElMessage.error(`获取列表失败：${error?.message}`);
  } finally {
    listState.isLoading = false;
  }
}

function create() {
  router.push({ path: "/agent/form", query: { mode: FormMode.Create } });
}

function edit(id: string) {
  router.push({ path: "/agent/form", query: { mode: FormMode.Edit, id } });
}

async function del(id: string) {
  ElMessageBox.confirm("确定要删除吗", "提示", {
    beforeClose: async (action, instance, done) => {
      if (action === "confirm") {
        instance.confirmButtonLoading = true;
        instance.confirmButtonText = "删除中...";
        try {
          await api.deleteAgentTool(id);
          ElMessage.success("删除成功");
          getList(); // 刷新列表
        } catch (error: any) {
          ElMessage.error(`删除失败：${error?.message}`);
        } finally {
          done();
          instance.confirmButtonLoading = false;
        }
      } else {
        done();
      }
    },
  });
}

onMounted(() => {
  getList();
});
</script>
