<template>
  <div>
    <h1>v2 purchase yy</h1>
    <el-button>go to detail</el-button>
    <goods-list></goods-list>
  </div>
</template>

<script>
import GoodsList from '@v2-purchase/components/goods-list.vue'

export default {
  components: {
    GoodsList
  },
  methods: {
    goToDetail () {
      this.$router.push('/v2/purchase/yy/detail')
    }
  }
}
</script>
