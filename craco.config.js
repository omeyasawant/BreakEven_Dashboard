module.exports = {
  webpack: {
    configure: (webpackConfig) => {
      const excludeSolanaSourcemaps =
        /node_modules[\\/](?:@solana|superstruct)[\\/]/;

      const rules = webpackConfig?.module?.rules;
      if (Array.isArray(rules)) {
        for (const rule of rules) {
          if (!rule) continue;

          // CRA adds source-map-loader as a pre-loader
          const isSourceMapLoader =
            rule.enforce === "pre" &&
            ((typeof rule.loader === "string" &&
              rule.loader.includes("source-map-loader")) ||
              (Array.isArray(rule.use) &&
                rule.use.some((u) =>
                  typeof u === "string"
                    ? u.includes("source-map-loader")
                    : typeof u?.loader === "string" &&
                      u.loader.includes("source-map-loader"),
                )));

          if (!isSourceMapLoader) continue;

          if (Array.isArray(rule.exclude)) {
            rule.exclude.push(excludeSolanaSourcemaps);
          } else if (rule.exclude) {
            rule.exclude = [rule.exclude, excludeSolanaSourcemaps];
          } else {
            rule.exclude = [excludeSolanaSourcemaps];
          }
        }
      }

      return webpackConfig;
    },
  },
};
