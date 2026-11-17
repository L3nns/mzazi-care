-- =====================================================================
--  Mzazi Care Discovery & Catalog System
--  Relational schema - MySQL 8.0
--  Matches the entity relationship diagram in Chapter Four (Figure 4.8).
-- =====================================================================
DROP DATABASE IF EXISTS mzazi_care;
CREATE DATABASE mzazi_care CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE mzazi_care;
SET NAMES utf8mb4;

CREATE TABLE users (
    user_id        INT AUTO_INCREMENT PRIMARY KEY,
    full_name      VARCHAR(150)  NOT NULL,
    email          VARCHAR(120)  NOT NULL UNIQUE,
    password_hash  VARCHAR(255)  NOT NULL,
    phone_number   VARCHAR(20),
    location       VARCHAR(120),
    role           ENUM('user','admin') NOT NULL DEFAULT 'user',
    token_version  INT           NOT NULL DEFAULT 0,  -- bumped to revoke all sessions
    mfa_secret     VARCHAR(255)  NULL,                -- TOTP secret, AES-GCM encrypted
    mfa_enabled    TINYINT(1)    NOT NULL DEFAULT 0,
    mfa_last_step  BIGINT        NULL,                -- last accepted TOTP step (no replay)
    created_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_users_role (role)
) ENGINE=InnoDB;

CREATE TABLE categories (
    category_id         INT AUTO_INCREMENT PRIMARY KEY,
    category_name       VARCHAR(120) NOT NULL,
    description         TEXT,
    parent_category_id  INT NULL,
    required_documents  VARCHAR(255) NULL,  -- comma-separated document types; NULL = inherit
    CONSTRAINT fk_cat_parent FOREIGN KEY (parent_category_id)
        REFERENCES categories(category_id) ON DELETE SET NULL,
    INDEX idx_cat_parent (parent_category_id)
) ENGINE=InnoDB;

CREATE TABLE providers (
    provider_id          INT AUTO_INCREMENT PRIMARY KEY,
    provider_name        VARCHAR(150) NOT NULL,
    category_id          INT NOT NULL,
    service_description  TEXT,
    service_tags         VARCHAR(255),
    location             VARCHAR(120),
    qualifications       TEXT,
    contact_email        VARCHAR(120),
    -- 'verified' is the APPROVED state; only verified listings are public.
    verification_status  ENUM('draft','pending','under_review','needs_more_information',
                              'verified','rejected','suspended','expired') NOT NULL DEFAULT 'pending',
    created_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_prov_cat FOREIGN KEY (category_id)
        REFERENCES categories(category_id) ON DELETE RESTRICT,
    INDEX idx_prov_category (category_id),
    INDEX idx_prov_location (location),
    INDEX idx_prov_status (verification_status),
    FULLTEXT KEY ft_prov_content (service_description, service_tags)
) ENGINE=InnoDB;

CREATE TABLE provider_media (
    media_id     INT AUTO_INCREMENT PRIMARY KEY,
    provider_id  INT NOT NULL,
    file_path    VARCHAR(255) NOT NULL,
    media_type   VARCHAR(40),                 -- 'image' (public) or 'evidence' (private)
    -- Evidence only: what the document is, its version and its review.
    document_type VARCHAR(40) NULL,
    version       INT NOT NULL DEFAULT 1,
    expires_on    DATE NULL,
    review_status ENUM('pending','accepted','rejected') NULL,
    reviewed_by   INT NULL,
    reviewed_at   DATETIME NULL,
    review_note   VARCHAR(500) NULL,
    uploaded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_media_prov FOREIGN KEY (provider_id)
        REFERENCES providers(provider_id) ON DELETE CASCADE,
    CONSTRAINT fk_media_reviewer FOREIGN KEY (reviewed_by)
        REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_media_expiry (media_type, review_status, expires_on)
) ENGINE=InnoDB;

-- Areas providers serve. Coordinates are approximate neighbourhood centres,
-- used for "about N km" and as a ranking feature; never a provider's address.
-- Rows are added by the backend migrations (backend/config/migrate.js).
CREATE TABLE service_areas (
    area_id    INT AUTO_INCREMENT PRIMARY KEY,
    area_name  VARCHAR(120) NOT NULL,
    latitude   DECIMAL(8,5) NULL,
    longitude  DECIMAL(8,5) NULL,
    is_active  TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_area_name (area_name)
) ENGINE=InnoDB;

-- A provider serves its primary location plus any other areas listed here.
CREATE TABLE provider_service_areas (
    provider_id INT NOT NULL,
    area_id     INT NOT NULL,
    PRIMARY KEY (provider_id, area_id),
    CONSTRAINT fk_psa_provider FOREIGN KEY (provider_id)
        REFERENCES providers(provider_id) ON DELETE CASCADE,
    CONSTRAINT fk_psa_area FOREIGN KEY (area_id)
        REFERENCES service_areas(area_id) ON DELETE CASCADE,
    INDEX idx_psa_area (area_id)
) ENGINE=InnoDB;

-- Explicit feedback on a recommendation. Kept apart from interactions: a
-- "not relevant" says nothing about a provider's quality or safety.
CREATE TABLE recommendation_feedback (
    feedback_id  INT AUTO_INCREMENT PRIMARY KEY,
    user_id      INT NOT NULL,
    provider_id  INT NOT NULL,
    feedback     ENUM('relevant','not_relevant','too_far','wrong_category','already_contacted') NOT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_rf_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_rf_provider FOREIGN KEY (provider_id) REFERENCES providers(provider_id) ON DELETE CASCADE,
    INDEX idx_rf_user (user_id, created_at)
) ENGINE=InnoDB;

-- Every change of verification status, with who made it and why.
-- actor_id is NULL for automatic changes (a document expiring).
CREATE TABLE provider_verification_events (
    event_id     INT AUTO_INCREMENT PRIMARY KEY,
    provider_id  INT NOT NULL,
    from_status  VARCHAR(30) NULL,
    to_status    VARCHAR(30) NOT NULL,
    reason       VARCHAR(500) NULL,
    actor_id     INT NULL,
    created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_vev_provider FOREIGN KEY (provider_id)
        REFERENCES providers(provider_id) ON DELETE CASCADE,
    CONSTRAINT fk_vev_actor FOREIGN KEY (actor_id)
        REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_vev_provider (provider_id, created_at)
) ENGINE=InnoDB;

CREATE TABLE user_preferences (
    preference_id      INT AUTO_INCREMENT PRIMARY KEY,
    user_id            INT NOT NULL,
    category_id        INT NOT NULL,
    preferred_location VARCHAR(120),
    preference_weight  DECIMAL(4,2) DEFAULT 1.00,
    updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_pref_user FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_pref_cat FOREIGN KEY (category_id)
        REFERENCES categories(category_id) ON DELETE CASCADE,
    UNIQUE KEY uq_pref (user_id, category_id)
) ENGINE=InnoDB;

CREATE TABLE search_history (
    search_id       INT AUTO_INCREMENT PRIMARY KEY,
    user_id         INT NOT NULL,
    query_text      VARCHAR(255),
    category_filter VARCHAR(120),
    location_filter VARCHAR(120),
    searched_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_search_user FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,
    INDEX idx_search_user (user_id, searched_at)
) ENGINE=InnoDB;

-- Rows of this table form the user-item matrix used by the k-NN
-- collaborative component (Section 4.8.2).
CREATE TABLE interactions (
    interaction_id     INT AUTO_INCREMENT PRIMARY KEY,
    user_id            INT NOT NULL,
    provider_id        INT NOT NULL,
    interaction_type   ENUM('view','click','save','rating') NOT NULL,
    rating_value       TINYINT NULL,
    interaction_weight DECIMAL(5,2) NOT NULL DEFAULT 1.00,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_int_user FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_int_prov FOREIGN KEY (provider_id)
        REFERENCES providers(provider_id) ON DELETE CASCADE,
    CONSTRAINT chk_rating CHECK (rating_value IS NULL OR rating_value BETWEEN 1 AND 5),
    -- One rating per parent per provider: rating again updates it. VIRTUAL,
    -- because a stored generated column cannot sit on cascading foreign keys.
    rating_pair VARCHAR(24)
        AS (IF(interaction_type = 'rating', CONCAT(user_id, ':', provider_id), NULL)) VIRTUAL,
    UNIQUE KEY uq_one_rating (rating_pair),
    INDEX idx_int_user (user_id, created_at),
    INDEX idx_int_prov (provider_id)
) ENGINE=InnoDB;

CREATE TABLE saved_services (
    saved_id    INT AUTO_INCREMENT PRIMARY KEY,
    user_id     INT NOT NULL,
    provider_id INT NOT NULL,
    saved_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_saved_user FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_saved_prov FOREIGN KEY (provider_id)
        REFERENCES providers(provider_id) ON DELETE CASCADE,
    UNIQUE KEY uq_saved (user_id, provider_id)
) ENGINE=InnoDB;

-- Output of the hybrid engine. The three score columns are kept separate so
-- that the contribution of each component can be measured (Section 3.2.5).
CREATE TABLE recommendations (
    recommendation_id   INT AUTO_INCREMENT PRIMARY KEY,
    user_id             INT NOT NULL,
    provider_id         INT NOT NULL,
    content_score       DECIMAL(6,4),
    collaborative_score DECIMAL(6,4),
    hybrid_score        DECIMAL(6,4),
    rank_position       INT,
    generated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_rec_user FOREIGN KEY (user_id)
        REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_rec_prov FOREIGN KEY (provider_id)
        REFERENCES providers(provider_id) ON DELETE CASCADE,
    INDEX idx_rec_user (user_id, generated_at)
) ENGINE=InnoDB;

-- Audit trail. `notes` carries the reason given when a listing is rejected
-- (Table 4.4, alternative flow) and similar free-text context.
CREATE TABLE admin_logs (
    log_id          INT AUTO_INCREMENT PRIMARY KEY,
    admin_id        INT NULL,          -- NULL once that account is deleted
    action_type     VARCHAR(60) NOT NULL,
    entity_affected VARCHAR(60),
    entity_id       INT,
    notes           VARCHAR(500) NULL,
    performed_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_log_admin FOREIGN KEY (admin_id)
        REFERENCES users(user_id) ON DELETE SET NULL,
    INDEX idx_log_entity (entity_affected, entity_id),
    INDEX idx_log_time (performed_at)
) ENGINE=InnoDB;
