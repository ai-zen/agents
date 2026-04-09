<template>
  <el-form-item
    prop="model_config.temperature"
    label="temperature"
    :rules="{
      type: 'number',
      min: 0.01,
      max: 0.99,
      required: false,
      transform: (v) => (v ? Number(v) : 0.95),
      message: '请输入0.01~0.99之间的正小数',
    }"
  >
    <el-text class="tips" size="small">
      采样温度，控制输出的随机性，必须为正数
      取值范围是：[0.0,1.0]，不能等于0，默认值为0.95,值越大，会使输出更随机，更具创造性；值越小，输出会更加稳定或确定。
      建议您根据应用智能体调整 top_p 或 temperature 参数，但不要同时调整两个参数
    </el-text>
    <el-switch
      size="small"
      :model-value="props.model_config.temperature !== undefined"
      @update:model-value="
        (v) => (props.model_config.temperature = v ? 0.95 : undefined)
      "
      active-text="使用自定义值"
      inactive-text="使用默认值"
    />
    <el-slider
      v-if="props.model_config.temperature !== undefined"
      :step="0.01"
      :min="0.01"
      :max="0.99"
      v-model="props.model_config.temperature"
    />
  </el-form-item>

  <el-form-item
    prop="model_config.top_p"
    label="top_p"
    :rules="{
      type: 'number',
      min: 0.01,
      max: 0.99,
      required: false,
      transform: (v) => (v ? Number(v) : 0.7),
      message: '请输入0~1之间的正小数',
    }"
  >
    <el-text class="tips" size="small">
      核取样，用温度取样的另一种方法，取值范围是：(0.0, 1.0) 开区间，不能等于 0
      或 1，默认值为 0.7 模型考虑具有 top_p 概率质量tokens的结果 例如：0.1
      意味着模型解码器只考虑从前 10% 的概率的候选集中取tokens
      建议您根据应用智能体调整 top_p 或 temperature 参数，但不要同时调整两个参数
    </el-text>
    <el-switch
      size="small"
      :model-value="props.model_config.top_p !== undefined"
      @update:model-value="
        (v) => (props.model_config.top_p = v ? 0.7 : undefined)
      "
      active-text="使用自定义值"
      inactive-text="使用默认值"
    />
    <el-slider
      v-if="props.model_config.top_p !== undefined"
      :step="0.01"
      :min="0.01"
      :max="0.99"
      v-model="props.model_config.top_p"
    />
  </el-form-item>

  <el-form-item
    prop="model_config.max_tokens"
    label="max_tokens"
    :rules="{
      type: 'integer',
      min: model_po.OUTPUT_MAX_TOKENS_LOWER_LIMIT,
      max: model_po.OUTPUT_MAX_TOKENS,
      required: false,
      transform: (v) =>
        v ? Number(v) : model_po.OUTPUT_MAX_TOKENS_LOWER_LIMIT,
      message: `请输${model_po.OUTPUT_MAX_TOKENS_LOWER_LIMIT}~${model_po.OUTPUT_MAX_TOKENS}之间的正整数`,
    }"
  >
    <el-text class="tips" size="small"> 最大输出TOKEN长度 </el-text>
    <el-switch
      size="small"
      :model-value="props.model_config.max_tokens !== undefined"
      @update:model-value="
        (v) =>
          (props.model_config.max_tokens = v
            ? model_po.OUTPUT_MAX_TOKENS_LOWER_LIMIT
            : undefined)
      "
      active-text="使用自定义值"
      inactive-text="使用默认值"
    />
    <el-slider
      v-if="props.model_config.max_tokens !== undefined"
      :step="1"
      :min="model_po.OUTPUT_MAX_TOKENS_LOWER_LIMIT"
      :max="model_po.OUTPUT_MAX_TOKENS"
      v-model="props.model_config.max_tokens"
    />
  </el-form-item>
</template>

<script setup lang="ts">
import { PropType } from "vue";
import { ChatPL } from "../../types/ChatPL";

const props = defineProps({
  model_config: {
    required: true,
    type: Object,
  },
  model_po: {
    required: true,
    type: Object as PropType<ChatPL.ModelPO>,
  },
});
</script>

<style lang="scss" scoped>
.tips {
  width: 100%;
  margin-bottom: 10px;
}

:deep() .el-switch--small .el-switch__label {
  height: auto;
}
</style>
