-- Esquema de transfer_db (transfer-service). Generado con pg_dump --schema-only desde la base
-- que crea TypeORM a partir de las entidades (src/**/entities, synchronize: true).
-- Restaurar en una base vacía:  psql "$DATABASE_URL" -f database/schema.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: transfer_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transfer_requests (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    source_account_id uuid NOT NULL,
    destination_account_number character varying(11) NOT NULL,
    amount numeric(18,2) NOT NULL,
    description character varying(140) DEFAULT 'Transferencia'::character varying NOT NULL,
    idempotency_key uuid NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    ledger_transaction_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    destination_key character varying(120),
    recipient_name character varying(80),
    destination_bank character varying(40),
    destination_account_type character varying(10),
    external_account_number character varying(16)
);


--
-- Name: transfer_requests PK_f97530bf47e4af43166089627ba; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfer_requests
    ADD CONSTRAINT "PK_f97530bf47e4af43166089627ba" PRIMARY KEY (id);


--
-- Name: IDX_99a5f61b472b6e60d940e2a01d; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_99a5f61b472b6e60d940e2a01d" ON public.transfer_requests USING btree (idempotency_key);


--
-- Name: idx_transfer_requests_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transfer_requests_user_created ON public.transfer_requests USING btree (user_id, created_at);


--
-- PostgreSQL database dump complete
--


