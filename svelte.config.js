import adapter from '@sveltejs/adapter-static';

export default {
  kit: {
    adapter: adapter({
      fallback: '404.html'
    }),
    paths: {
      // Replace 'ftc-planner' with your actual GitHub repo name
      base: process.env.NODE_ENV === 'production' ? '/ftc-planner' : '',
    },
  },
};