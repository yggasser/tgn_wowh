(ns taganrog_history_massiv.server
  (:require
    [ring.adapter.jetty :refer [run-jetty]]
    [taganrog_history_massiv.site :as site])
  (:gen-class))

(defn -main [& _]
  (let [port (or (some-> (System/getenv "PORT") parse-long) 8080)]
    (println (str "Starting viewer on http://localhost:" port "/"))
    (run-jetty site/app {:port port :join? false})))
