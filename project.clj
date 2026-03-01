(defproject taganrog-history-massiv "0.1.0"
  :description "Taganrog objects viewer"
  :dependencies [[org.clojure/clojure "1.11.1"]
                 [cheshire "5.13.0"]
                 [compojure "1.7.1"]
                 [ring/ring-core "1.11.0"]
                 [ring/ring-jetty-adapter "1.11.0"]
                 [ring/ring-json "0.5.1"]]
  :main taganrog_history_massiv.server
  :resource-paths ["resources"]
  :target-path "target/%s")