<template>
  <el-form-item prop="endpoint_config.zhipu_endpoint" label="zhipu_endpoint">
    <el-input
      v-model="props.endpoint_config.zhipu_endpoint"
      placeholder="请输入 zhipu_endpoint"
    />
  </el-form-item>

  <el-form-item
    prop="endpoint_config.api_key"
    label="api_key"
    :rules="{ required: true, message: '请输入 api_key' }"
  >
    <el-input
      v-model="props.endpoint_config.api_key"
      placeholder="请输入 api_key"
    />
  </el-form-item>

  <el-form-item prop="endpoint_config.headers" label="headers">
    <JsonEditor v-model="props.endpoint_config.headers" />
  </el-form-item>

  <el-form-item prop="endpoint_config.body" label="body">
    <JsonEditor v-model="props.endpoint_config.body" />
  </el-form-item>
</template>

<script setup lang="ts">
import JsonEditor from "../JsonEditor/index.vue";

const props = defineProps({
  endpoint_config: {
    required: true,
    type: Object,
  },
});
</script>
