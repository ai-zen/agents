<template>
  <el-form-item
    prop="model_config.temperature"
    label="temperature"
    :rules="{
      type: 'number',
      min: 0,
      max: 2,
      required: false,
      transform: (v) => (v ? Number(v) : 0.5),
      message: '请输入0~2之间的正小数',
    }"
  >
    <el-text class="tips" size="small">
      温度：要使用的采样温度，介于 0 和 2 之间。 较高的值（如
      0.8）将使输出更随机，而较小的值（如 0.2）将使输出更集中，更具确定性。
      我们通常建议更改此设置或 top_p，但不能同时更改两者。
    </el-text>
    <el-switch
      size="small"
      :model-value="props.model_config.temperature !== undefined"
      @update:model-value="
        (v) => (props.model_config.temperature = v ? 1 : undefined)
      "
      active-text="使用自定义值"
      inactive-text="使用默认值"
    />
    <el-slider
      v-if="props.model_config.temperature !== undefined"
      :step="0.01"
      :min="0"
      :max="2"
      v-model="props.model_config.temperature"
    />
  </el-form-item>

  <el-form-item
    prop="model_config.top_p"
    label="top_p"
    :rules="{
      type: 'number',
      min: 0,
      max: 1,
      required: false,
      transform: (v) => (v ? Number(v) : 0.5),
      message: '请输入0~1之间的正小数',
    }"
  >
    <el-text class="tips" size="small">
      顶部 P：温度采样的替代方法，称为核采样，其中模型考虑具有 top_p
      概率质量的令牌的结果。 所以 0.1 意味着只考虑包含前 10% 概率质量的令牌。
      我们通常建议更改此设置或温度，但不要同时更改这两者。
    </el-text>
    <el-switch
      size="small"
      :model-value="props.model_config.top_p !== undefined"
      @update:model-value="
        (v) => (props.model_config.top_p = v ? 0.5 : undefined)
      "
      active-text="使用自定义值"
      inactive-text="使用默认值"
    />
    <el-slider
      v-if="props.model_config.top_p !== undefined"
      :step="0.01"
      :min="0"
      :max="1"
      v-model="props.model_config.top_p"
    />
  </el-form-item>

  <el-form-item
    prop="model_config.frequency_penalty"
    label="frequency_penalty"
    :rules="{
      type: 'number',
      min: -2,
      max: 2,
      required: false,
      transform: (v) => (v ? Number(v) : 0),
      message: '请输入-2~2之间的小数',
    }"
  >
    <el-text class="tips" size="small">
      状态惩罚：介于 -2.0 和 2.0 之间的数字。
      正值会根据它们到目前为止在文本中的现有频率来惩罚新令牌，从而降低模型逐字重复同一行的可能性。
    </el-text>
    <el-switch
      size="small"
      :model-value="props.model_config.frequency_penalty !== undefined"
      @update:model-value="
        (v) => (props.model_config.frequency_penalty = v ? 0 : undefined)
      "
      active-text="使用自定义值"
      inactive-text="使用默认值"
    />
    <el-slider
      v-if="props.model_config.frequency_penalty !== undefined"
      :step="0.01"
      :min="-2"
      :max="2"
      v-model="props.model_config.frequency_penalty"
    />
  </el-form-item>

  <el-form-item
    prop="model_config.presence_penalty"
    label="presence_penalty"
    :rules="{
      type: 'number',
      min: -2,
      max: 2,
      required: false,
      transform: (v) => (v ? Number(v) : 0),
      message: '请输入-2~2之间的小数',
    }"
  >
    <el-text class="tips" size="small">
      频率损失：介于 -2.0 和 2.0 之间的数字。
      正值会根据它们到目前为止是否在文本中出现来惩罚新令牌，从而增加模型谈论新话题的可能性。
    </el-text>
    <el-switch
      size="small"
      :model-value="props.model_config.presence_penalty !== undefined"
      @update:model-value="
        (v) => (props.model_config.presence_penalty = v ? 0 : undefined)
      "
      active-text="使用自定义值"
      inactive-text="使用默认值"
    />
    <el-slider
      v-if="props.model_config.presence_penalty !== undefined"
      :step="0.01"
      :min="-2"
      :max="2"
      v-model="props.model_config.presence_penalty"
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
