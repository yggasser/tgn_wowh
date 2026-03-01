(ns taganrog_history_massiv.site
  (:require
    [clojure.java.io :as io]
    [clojure.string :as str]
    [clojure.set :as set]
    [cheshire.core :as json]
    [compojure.core :refer :all]
    [compojure.route :as route])
  (:import (java.util.zip CRC32)
           (java.io File)
           (java.net URLDecoder)))

(defonce state
  (atom {:loaded? false
         :features []
         :by-id {}
         :idnorm->id {}
         :feature-by-id {}
         :fidnorm->id {}
         :categories []
         :slug->cat {}
         :edits {}
         :load-error nil}))

(defn- json-response [data]
  {:status 200
   :headers {"Content-Type" "application/json; charset=utf-8"}
   :body (json/generate-string data)})

(defn- error-response [status data]
  {:status status
   :headers {"Content-Type" "application/json; charset=utf-8"}
   :body (json/generate-string data)})

(defn- parse-json-body [req]
  (try
    (let [raw (some-> req :body slurp str/trim)]
      (if (str/blank? raw)
        {}
        (json/parse-string raw true)))
    (catch Exception _
      {})))

(defn- slurp-utf8 [res] (slurp res :encoding "UTF-8"))

(defn- read-json-resource [path]
  (some-> (io/resource path) slurp-utf8 (json/parse-string true)))

(defn- stringify-top-keys
  "Cheshire parse-string with keywordize=true turns JSON object keys into keywords.
  For objects_by_id.json and edits.json the *top-level* keys are object IDs and must be strings.
  This converts only top-level keys to strings and leaves nested keys keywordized."
  [m]
  (if (map? m)
    (into {}
          (map (fn [[k v]]
                 [(cond
                    (string? k) k
                    (keyword? k) (name k)
                    :else (str k))
                  v]))
          m)
    {}))

(defn- cat->slug ^String [^String s]
  (let [crc (CRC32.)]
    (.update crc (.getBytes s "UTF-8"))
    (str "c_" (format "%08x" (.getValue crc)))))

(defn- edits-file ^File []
  (doto (io/file "data") (.mkdirs))
  (io/file "data" "edits.json"))

(defn- read-edits []
  (let [f (edits-file)]
    (if (.exists f)
      (-> (json/parse-string (slurp f :encoding "UTF-8") true)
          stringify-top-keys)
      {})))

(defn- write-edits! [m]
  (let [f (edits-file)
        tmp (io/file (.getParentFile f) (str (.getName f) ".tmp"))]
    (spit tmp (json/generate-string m {:pretty true}) :encoding "UTF-8")
    (when (.exists f) (.delete f))
    (.renameTo tmp f)))

(defn- apply-edit-to-object [obj edit]
  (cond-> obj
    (contains? edit :title) (assoc :title (:title edit))
    (contains? edit :description) (assoc :description (:description edit)
                                         :описание (:description edit))
    (contains? edit :categories) (assoc :categories (:categories edit)
                                        :wm-категория (:categories edit))
    (contains? edit :viewer_color) (assoc :viewer_color (:viewer_color edit))))

(defn- apply-edit-to-feature [feature edit]
  (-> feature
      (cond-> (contains? edit :title)
        (assoc-in [:properties :title] (:title edit)))
      (cond-> (contains? edit :categories)
        (assoc-in [:properties :categories] (:categories edit)))
      (cond-> (contains? edit :viewer_color)
        (assoc-in [:properties :viewer_color] (:viewer_color edit)))
      (assoc-in [:properties :id]
                (or (:id feature) (get-in feature [:properties :id])))))

(defn- normalize-edit-payload [payload]
  (let [title (some-> (:title payload) str str/trim)
        description (some-> (:description payload) str)
        categories (when (contains? payload :categories)
                     (let [v (:categories payload)]
                       (cond
                         (vector? v) (mapv (comp str str/trim) v)
                         (seq? v) (mapv (comp str str/trim) v)
                         (nil? v) []
                         :else [])))
        viewer-color (when (contains? payload :viewer_color)
                       (let [c (some-> (:viewer_color payload) str str/trim)]
                         (when (and (some? c) (re-matches #"(?i)^#[0-9a-f]{6}$" c))
                           (str/upper-case c))))]
    (cond-> {}
      (and (some? title) (not (str/blank? title))) (assoc :title title)
      (some? description) (assoc :description description)
      (some? categories) (assoc :categories categories)
      (some? viewer-color) (assoc :viewer_color viewer-color))))

(defn- update-in-memory! [id edit]
  (swap! state
         (fn [st]
           (let [edits (assoc (:edits st) id (merge (get (:edits st) id {}) edit))
                 by-id (if-let [obj (get (:by-id st) id)]
                         (assoc (:by-id st) id (apply-edit-to-object obj (get edits id)))
                         (:by-id st))
                 features (mapv (fn [f]
                                  (let [fid (or (:id f) (get-in f [:properties :id]))]
                                    (if (= fid id)
                                      (apply-edit-to-feature f (get edits id))
                                      f)))
                                (:features st))]
             (-> st
                 (assoc :edits edits)
                 (assoc :by-id by-id)
                 (assoc :features features))))))

(defn- normalize-id ^String [s]
  (-> (str s)
      str/trim
      (str/replace "\u00A0" " ")
      str/lower-case
      (str/replace "ё" "е")
      ;; make ids stable across tiny punctuation differences (e.g. "ул._" vs "ул_")
      (str/replace #"\\." "")
      (str/replace #"[\\s/\\\\]+" "_")
      (str/replace #"[^0-9a-zа-я_\\-]+" "_")
      (str/replace #"-+" "_")
      (str/replace #"_+" "_")
      (str/replace #"^_+" "")
      (str/replace #"_+$" "")))

(defn- maybe-fix-mojibake ^String [^String s]
  ;; If URI decoding used ISO-8859-1 by mistake, Cyrillic turns into "Ð..." / "Ñ..." sequences.
  ;; Try to reverse that (ISO-8859-1 bytes -> UTF-8 string) with a small heuristic.
  (try
    (let [s (or s "")
          looks-like? (re-find #"[ÐÑ]" s)
          fixed (String. (.getBytes s "ISO-8859-1") "UTF-8")]
      (if (and looks-like? (re-find #"[А-Яа-яЁё]" fixed)) fixed s))
    (catch Exception _ s)))

(defn- decode-id ^String [^String s]
  ;; 1) URL-decode (if still encoded) using UTF-8
  ;; 2) fix potential mojibake
  (let [s0 (or s "")
        s1 (try (URLDecoder/decode s0 "UTF-8") (catch Exception _ s0))
        s2 (maybe-fix-mojibake s1)]
    s2))

(defn- build-id-index [by-id]
  (reduce (fn [m k]
            (let [nk (normalize-id k)]
              (if (and (not (str/blank? nk)) (not (contains? m nk)))
                (assoc m nk k)
                m)))
          {}
          (keys by-id)))

(defn- ensure-prop-id [feature]
  (let [id (or (:id feature) (get-in feature [:properties :id]))]
    (assoc-in feature [:properties :id] id)))

(defn- feature-props [f]
  (let [p (:properties f)]
    (assoc p :id (or (get p :id) (:id f)))))

(defn- pick-viewer-color [obj]
  (let [c (or (:viewer_color obj)
              (:viewer-color obj)
              (get obj :viewerColor)
              (:color obj)
              (:цвет obj)
              (:marker_color obj)
              (:marker-color obj))]
    (when (and (some? c) (not (str/blank? (str c))))
      (str/trim (str c)))))

(defn- apply-viewer-color-to-feature [feature by-id]
  (let [id (or (get-in feature [:properties :id]) (:id feature))
        obj (when id (get by-id id))
        c (when obj (pick-viewer-color obj))]
    (cond-> feature
      c (assoc-in [:properties :viewer_color] c))))

(defn- build-feature-index [features]
  (let [by-id (reduce (fn [m f]
                        (let [id (get-in f [:properties :id])]
                          (if (and id (not (str/blank? (str id))) (not (contains? m id)))
                            (assoc m id (feature-props f))
                            m)))
                      {}
                      features)
        idnorm->id (build-id-index by-id)]
    {:feature-by-id by-id
     :fidnorm->id idnorm->id}))

(defn load-data! []
  (when-not (:loaded? @state)
    (try
      (let [geo   (read-json-resource "data/objects_min.geojson")
            geo2  (read-json-resource "data/objects_extra.geojson")
            by0   (read-json-resource "data/objects_by_id.json")
            cats0 (read-json-resource "data/categories.json")
            edits (read-edits)]
        (when-not geo   (throw (ex-info "Missing resources/data/objects_min.geojson" {})))
        (when-not by0   (throw (ex-info "Missing resources/data/objects_by_id.json" {})))
        (when-not cats0 (throw (ex-info "Missing resources/data/categories.json" {})))

        (let [by0 (stringify-top-keys by0)
              cats (mapv (fn [{:keys [category count] :as m}]
                           (let [cat (str category)]
                             (assoc m :category cat :count count :slug (cat->slug cat))))
                         cats0)
              slug->cat (into {} (map (fn [{:keys [slug category]}] [slug category]) cats))
              features0a (->> (:features geo) (map ensure-prop-id) vec)
              featuresX (->> (or (:features geo2) []) (map ensure-prop-id) vec)
              features0  (if (empty? featuresX)
                          features0a
                          (let [seen (set (keep #(get-in % [:properties :id]) features0a))]
                            (into features0a (remove #(contains? seen (get-in % [:properties :id])) featuresX))))

              ;; apply stored edits to full objects
              by1 (reduce-kv
                   (fn [acc id edit]
                     (if-let [obj (get acc id)]
                       (assoc acc id (apply-edit-to-object obj edit))
                       acc))
                   by0 edits)

              ;; apply stored edits to features
              features1 (mapv (fn [f]
                                (let [id (get-in f [:properties :id])
                                      edit (get edits id)]
                                  (if edit (apply-edit-to-feature f edit) f)))
                              features0)

              ;; attach viewer color from objects_by_id.json to features (so the map can style without extra calls)
              features2 (mapv #(apply-viewer-color-to-feature % by1) features1)

              idnorm->id (build-id-index by1)
              {:keys [feature-by-id fidnorm->id]} (build-feature-index features2)]

          (reset! state {:loaded? true
                         :features features2
                         :by-id by1
                         :idnorm->id idnorm->id
                         :feature-by-id feature-by-id
                         :fidnorm->id fidnorm->id
                         :categories cats
                         :slug->cat slug->cat
                         :edits edits
                         :load-error nil})))
      (catch Exception e
        (reset! state {:loaded? false
                       :features []
                       :by-id {}
                       :idnorm->id {}
                       :feature-by-id {}
                       :fidnorm->id {}
                       :categories []
                       :slug->cat {}
                       :edits {}
                       :load-error (.getMessage e)})))))

(defn- parse-bbox [s]
  (when (and s (not (str/blank? s)))
    (let [[w s2 e n] (map #(Double/parseDouble %) (str/split s #","))]
      {:w w :s s2 :e e :n n})))

(defn- bbox-intersects? [{:keys [w s e n]} [ow os oe on]]
  (and (<= w oe) (<= ow e) (<= s on) (<= os n)))

(defn- q-match? [q props]
  (if (str/blank? q)
    true
    (let [q (str/lower-case q)
          hay (->> [(get props :title) (get props :street) (get props :id)]
                   (remove nil?) (str/join " ") str/lower-case)]
      (str/includes? hay q))))

(defn- filter-features-raw [{:keys [bbox q]} features]
  (let [bbox (or bbox {:w -180 :s -90 :e 180 :n 90})]
    (->> features
         (filter (fn [f]
                   (let [p    (feature-props f)
                         obox (:bbox p)]
                     (and (vector? obox)
                          (= 4 (count obox))
                          (bbox-intersects? bbox obox)
                          (q-match? q p)))))
         (take 12000)
         vec)))

(defn- normalize-cats [v]
  (cond
    (vector? v) v
    (seq? v) (vec v)
    (string? v) [v]
    :else []))

(defn- normcat [s] (-> (str s) str/trim str/lower-case))

(defn- feature-cats-norm [props]
  (let [cats (or (:categories props)
                 (:wm-категория props)
                 (get props "wm-категория")
                 (get props "wm-category")
                 [])]
    (->> (normalize-cats cats) (map normcat) (remove str/blank?) set)))

(defn- filter-features-by-cats [{:keys [bbox cats q]} features]
  (let [bbox (or bbox {:w -180 :s -90 :e 180 :n 90})
        cats (set (map normcat cats))]
    (->> features
         (filter (fn [f]
                   (let [p     (feature-props f)
                         obox  (:bbox p)
                         fcats (feature-cats-norm p)]
                     (and (vector? obox)
                          (= 4 (count obox))
                          (bbox-intersects? bbox obox)
                          (not-empty (set/intersection cats fcats))
                          (q-match? q p)))))
         (take 8000)
         vec)))

(defn- param->vec [v]
  (cond (nil? v) [] (vector? v) v (seq? v) (vec v) :else [v]))

(defn- expand-cat-params [raw]
  (->> raw (mapcat #(str/split (str %) #",")) (map str/trim) (remove str/blank?)))

(defn- feature-props-by-id-or-norm [id]
  (let [id (decode-id id)
        by (:feature-by-id @state)
        nmap (:fidnorm->id @state)
        nk (normalize-id id)]
    (or (get by id)
        (when-let [rid (get nmap nk)]
          (get by rid)))))

(defn- object-by-id-or-norm [id]
  (let [id (decode-id id)
        by (:by-id @state)
        nmap (:idnorm->id @state)
        nk (normalize-id id)
        rid (get nmap nk)]
    (or (get by id)
        (when rid (get by rid)))))

(defroutes app
  (GET "/" []
    (load-data!)
    (if-let [err (:load-error @state)]
      {:status 500
       :headers {"Content-Type" "text/plain; charset=utf-8"}
       :body (str "DATA LOAD ERROR:\n" err)}
      (-> (io/resource "public/index.html") slurp-utf8)))

  (route/resources "/" {:root "public"})

  (GET "/api/categories" []
    (load-data!)
    (if-let [err (:load-error @state)]
      (error-response 500 {:error "data_load_failed" :message err})
      (json-response (:categories @state))))

  (GET "/api/objects_raw" req
    (load-data!)
    (if-let [err (:load-error @state)]
      (error-response 500 {:error "data_load_failed" :message err})
      (let [params (:params req)
            bbox   (parse-bbox (get params "bbox"))
            q      (get params "q")]
        (json-response {:type "FeatureCollection"
                        :features (filter-features-raw {:bbox bbox :q q} (:features @state))}))))

  (GET "/api/objects" req
    (load-data!)
    (if-let [err (:load-error @state)]
      (error-response 500 {:error "data_load_failed" :message err})
      (let [params (:params req)
            bbox   (parse-bbox (get params "bbox"))
            q      (get params "q")
            raw0   (param->vec (get params "cat"))
            raw    (expand-cat-params raw0)
            slug->cat (:slug->cat @state)
            cats   (->> raw (map (fn [x] (or (get slug->cat x) x))) set)]
        (if (empty? cats)
          (json-response {:type "FeatureCollection" :features []})
          (json-response {:type "FeatureCollection"
                          :features (filter-features-by-cats {:bbox bbox :cats cats :q q} (:features @state))})))))

  (GET "/api/object/:id" [id]
    (load-data!)
    (if-let [err (:load-error @state)]
      (error-response 500 {:error "data_load_failed" :message err})
      (let [raw-id id
            id (decode-id id)
            obj (object-by-id-or-norm id)
            feat (feature-props-by-id-or-norm id)
            id-out (or (:id obj) (:id feat) id)
            title (or (:title obj) (:title feat) (get obj :wm-название) (get obj "wm-название"))
            color (or (when obj (pick-viewer-color obj))
                      (:viewer_color feat))
            obj2 (cond
                   obj (cond-> (assoc obj :id id-out)
                         color (assoc :viewer_color color)
                         (and feat (not (contains? obj :bbox)) (contains? feat :bbox))
                         (assoc :bbox (:bbox feat)))
                   feat {:id id-out
                         :title title
                         :street (:street feat)
                         :wm-категория (or (:wm-категория feat) (:categories feat))
                         :description (:description feat)
                         :bbox (:bbox feat)
                         :viewer_color color
                         :_viewer {:partial true
                                  :warning "Полной карточки нет в objects_by_id.json — показаны только данные из GeoJSON."}})]
        (if obj2
          (json-response obj2)
          (error-response 404 {:error "not_found"
                               :id raw-id
                               :decoded id
                               :normalized (normalize-id id)})))))

  (PUT "/api/object/:id" req
    (load-data!)
    (if-let [err (:load-error @state)]
      (error-response 500 {:error "data_load_failed" :message err})
      (let [id (decode-id (get-in req [:params :id]))
            payload (parse-json-body req)
            edit (normalize-edit-payload payload)
            real (or (when (contains? (:by-id @state) id) id)
                     (get (:idnorm->id @state) (normalize-id id)))]
        (if (and real (contains? (:by-id @state) real))
          (do
            (update-in-memory! real edit)
            (write-edits! (:edits @state))
            (json-response {:ok true :id real :edit edit}))
          (error-response 404 {:error "not_found" :id id :normalized (normalize-id id)})))))

  (route/not-found "<h1>not found</h1>"))
